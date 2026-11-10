package integration_test

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/app"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/realtime"
	documentfixture "github.com/simplexai-labs/linger/apps/teamhub/tests/integration/documents/fixture"
)

type roomDocumentCollaborationCredential struct {
	DocumentID              string    `json:"document_id"`
	CollaborationCredential string    `json:"collaboration_credential"`
	ExpiresAt               time.Time `json:"expires_at"`
}

// claims decodes the signed connection token; the Document Runtime owns
// verification.
func (credential roomDocumentCollaborationCredential) claims(t *testing.T) document.ConnectionTokenClaims {
	t.Helper()
	return documentfixture.ConnectionTokenClaims(t, credential.CollaborationCredential)
}

func TestDuplicateRoomMemberInsertReusesCurrentMembershipEpoch(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := createPrivateRoom(t, env, alice, "Membership epoch "+suffix, "membership-epoch-room-"+suffix)
	var epochID string
	if err := env.pool.QueryRow(t.Context(), `SELECT membership_epoch_id FROM room_members WHERE room_id=$1 AND actor_id='actor_acme_alice'`, roomID).Scan(&epochID); err != nil {
		t.Fatal(err)
	}

	result, err := env.pool.Exec(t.Context(), `
		INSERT INTO room_members(room_id,tenant_id,actor_id,role,added_by_actor_id)
		VALUES($1,$2,'actor_acme_alice','owner','actor_acme_alice')
		ON CONFLICT (room_id,actor_id) DO NOTHING`, roomID, acmeTenant)
	if err != nil {
		t.Fatal(err)
	}
	if result.RowsAffected() != 0 {
		t.Fatalf("duplicate membership inserted %d rows", result.RowsAffected())
	}
	if count := countRows(t, env, `
		SELECT count(*) FROM room_members
		WHERE room_id=$1 AND actor_id='actor_acme_alice' AND membership_epoch_id=$2`, roomID, epochID); count != 1 {
		t.Fatalf("duplicate membership changed the current membership epoch: %d", count)
	}
}

func TestRoomDocumentMemberCanIssueCollaborationCredential(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newRoomDocumentRealtimeEnv(t)
	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	roomID := createPrivateRoom(t, env, alice, "Realtime document "+suffix, "realtime-document-room-"+suffix)

	status, _, body := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/documents", map[string]any{}, "realtime-document-"+suffix)
	if status != http.StatusCreated {
		t.Fatalf("create Room Document status=%d body=%s", status, body)
	}
	var document roomDocumentResponse
	decode(t, body, &document)

	issuedAt := time.Now()
	status, _, body = env.request(alice, http.MethodPost, "/v0/documents/"+document.ID+"/collaboration-credentials", nil, "")
	if status != http.StatusCreated {
		t.Fatalf("issue collaboration credential status=%d body=%s", status, body)
	}
	var credential roomDocumentCollaborationCredential
	decode(t, body, &credential)
	claims := credential.claims(t)
	if credential.DocumentID != document.ID || claims.DocumentID != document.ID ||
		claims.ActorID != "actor_acme_alice" || claims.Mode != "write" || claims.SessionID == "" ||
		!credential.ExpiresAt.After(issuedAt) {
		t.Fatalf("invalid collaboration credential: %+v claims=%+v", credential, claims)
	}
	t.Run("open returns authorized metadata and a usable session together", func(t *testing.T) {
		status, headers, body := env.request(alice, http.MethodPost, "/v0/documents/"+document.ID+"/open", nil, "")
		if status != http.StatusOK {
			t.Fatalf("open status=%d body=%s", status, body)
		}
		if !strings.Contains(headers.Get("Cache-Control"), "no-store") {
			t.Fatal("session response must not be cached")
		}
		var opened struct {
			Document struct {
				ID              string `json:"id"`
				DraftCapability string `json:"draft_capability"`
			} `json:"document"`
			Credential roomDocumentCollaborationCredential `json:"collaboration_credential"`
		}
		decode(t, body, &opened)
		if opened.Document.ID != document.ID || opened.Document.DraftCapability != "write" || opened.Credential.DocumentID != document.ID {
			t.Fatalf("invalid open identity/capability: document=%s capability=%s", opened.Document.ID, opened.Document.DraftCapability)
		}
		if loaded, ok := loadRuntimeDocumentBody(t, env, opened.Credential.DocumentID); !ok ||
			loaded.PermissionCount != opened.Credential.claims(t).PermissionCount {
			t.Fatalf("Runtime load=%+v ok=%t", loaded, ok)
		}
	})

}

// runtimeDocumentBody is what the Document Runtime loads for a connection.
type runtimeDocumentBody struct {
	PermissionCount, Seq int64
	State, StateVector   []byte
	AssetIDs, ThreadIDs  []string
}

// loadRuntimeDocumentBody runs the Document Runtime's load
// (apps/node-services/src/document/bodies.ts); ok is false for a Document
// that is not an active native Document.
func loadRuntimeDocumentBody(t *testing.T, env *testEnv, documentID string) (runtimeDocumentBody, bool) {
	t.Helper()
	var body runtimeDocumentBody
	err := env.pool.QueryRow(t.Context(), `SELECT permission.permission_count,body.seq,body.state,
		body.state_vector,body.asset_ids,body.thread_ids
		FROM documents document
		JOIN document_permission_counts permission ON permission.document_id=document.id
		JOIN document_bodies body ON body.document_id=document.id
		WHERE document.id=$1 AND document.status='active' AND document.format='blocknote'`, documentID).Scan(
		&body.PermissionCount, &body.Seq, &body.State, &body.StateVector, &body.AssetIDs, &body.ThreadIDs)
	if errors.Is(err, pgx.ErrNoRows) {
		return runtimeDocumentBody{}, false
	}
	if err != nil {
		t.Fatal(err)
	}
	return body, true
}

// checkRuntimeReferences runs the Document Runtime's check of the Asset and
// Comment Thread references a frame adds.
func checkRuntimeReferences(t *testing.T, env *testEnv, documentID string, assetIDs, threadIDs []string) string {
	t.Helper()
	var active bool
	var assets, threads int
	if err := env.pool.QueryRow(t.Context(), `SELECT
		EXISTS (SELECT 1 FROM documents WHERE id=$1 AND status='active' AND format='blocknote'),
		(SELECT count(*) FROM document_assets WHERE document_id=$1 AND status='available' AND id=ANY($2::text[])),
		(SELECT count(*) FROM room_document_comment_threads WHERE document_id=$1 AND id=ANY($3::text[]))`,
		documentID, assetIDs, threadIDs).Scan(&active, &assets, &threads); err != nil {
		t.Fatal(err)
	}
	switch {
	case !active:
		return "document_unavailable"
	case assets != len(assetIDs):
		return "asset_unavailable"
	case threads != len(threadIDs):
		return "thread_unknown"
	}
	return "available"
}

func newRoomDocumentRealtimeEnv(t *testing.T) (*testEnv, *http.Client) {
	return newRoomDocumentRealtimeEnvWithOptions(t, 0, 0, 0)
}

func newRoomDocumentRealtimeEnvWithAssetLifetimes(
	t *testing.T,
	stagingRetention time.Duration,
	assetGCGrace time.Duration,
) (*testEnv, *http.Client) {
	return newRoomDocumentRealtimeEnvWithOptions(t, 0, stagingRetention, assetGCGrace)
}

func newRoomDocumentRealtimeEnvWithOptions(
	t *testing.T,
	poolMaxConns int,
	stagingRetention time.Duration,
	assetGCGrace time.Duration,
) (*testEnv, *http.Client) {
	return newRoomDocumentRealtimeEnvWithRuntimeOptions(t, poolMaxConns, stagingRetention, assetGCGrace, roomDocumentRuntimeTestOptions{})
}

func newRoomDocumentRealtimeEnvWithInvalidRevisionExport(t *testing.T) (*testEnv, *http.Client) {
	return newRoomDocumentRealtimeEnvWithRuntimeOptions(t, 0, 0, 0, roomDocumentRuntimeTestOptions{
		revisionExport:        true,
		invalidRevisionExport: true,
	})
}

type roomDocumentRuntimeTestOptions struct {
	appOptions                 []appOption
	blankStateBytes            []byte
	failBlankMaterialization   bool
	revisionExport             bool
	invalidRevisionExport      bool
	invalidFirstRevisionExport bool
	wikiCandidateGenerator     document.WikiCandidateGenerator
	jobPollInterval            time.Duration
	assetMaxBytes              int64
	assetDocumentMaxBytes      int64
	assetDocumentMaxObjects    int32
	assetTenantMaxBytes        int64
	assetTenantMaxObjects      int32
	assetStorageReserveBytes   int64
	disableRoomDocumentWorkers bool
}

func newRoomDocumentRealtimeEnvWithRuntimeOptions(
	t *testing.T,
	poolMaxConns int,
	stagingRetention time.Duration,
	assetGCGrace time.Duration,
	runtimeOptions roomDocumentRuntimeTestOptions,
) (*testEnv, *http.Client) {
	t.Helper()
	if runtimeOptions.assetStorageReserveBytes <= 0 {
		runtimeOptions.assetStorageReserveBytes = 1
	}
	runtimeToken := nodeServicesInternalToken
	stateBytes := runtimeOptions.blankStateBytes
	if len(stateBytes) == 0 {
		stateBytes = []byte{1, 2, 3, 4}
	}
	stateDigest := sha256.Sum256(stateBytes)
	var revisionExportCount atomic.Int32
	runtime := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost {
			http.NotFound(w, request)
			return
		}
		if request.Header.Get("Authorization") != "Bearer "+runtimeToken {
			http.Error(w, `{"code":"unauthenticated","message":"invalid token","retryable":false}`, http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/internal/v1/documents/import":
			if runtimeOptions.failBlankMaterialization {
				http.Error(w, `{"code":"unavailable","message":"temporary materialization failure","retryable":true}`, http.StatusServiceUnavailable)
				return
			}
			var materializeRequest struct {
				AllowedDocumentAssetIDs []string `json:"allowed_document_asset_ids"`
			}
			if err := json.NewDecoder(request.Body).Decode(&materializeRequest); err != nil {
				http.Error(w, `{"code":"invalid_request","message":"invalid materialize request","retryable":false}`, http.StatusBadRequest)
				return
			}
			if materializeRequest.AllowedDocumentAssetIDs == nil {
				materializeRequest.AllowedDocumentAssetIDs = []string{}
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"state_bytes":        base64.StdEncoding.EncodeToString(stateBytes),
				"bytes_sha256":       hex.EncodeToString(stateDigest[:]),
				"state_vector":       "AA==",
				"state_hash":         hex.EncodeToString(stateDigest[:]),
				"state_hash_version": 1,
				"complete_references": map[string]any{
					"document_asset_ids":  materializeRequest.AllowedDocumentAssetIDs,
					"document_thread_ids": []string{},
				},
				"warnings": []string{},
			})
		case "/internal/v1/documents/export":
			if !runtimeOptions.revisionExport {
				http.NotFound(w, request)
				return
			}
			exportNumber := revisionExportCount.Add(1)
			var export struct {
				State struct {
					CompleteReferences struct {
						DocumentAssetIDs  []string `json:"document_asset_ids"`
						DocumentThreadIDs []string `json:"document_thread_ids"`
					} `json:"complete_references"`
				} `json:"state"`
			}
			if err := json.NewDecoder(request.Body).Decode(&export); err != nil {
				http.Error(w, `{"code":"invalid_request","message":"invalid export request","retryable":false}`, http.StatusBadRequest)
				return
			}
			readable := []byte("# Document Agent input\n")
			digest := sha256.Sum256(readable)
			sha := hex.EncodeToString(digest[:])
			if runtimeOptions.invalidRevisionExport || (runtimeOptions.invalidFirstRevisionExport && exportNumber == 1) {
				sha = strings.Repeat("0", 64)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"media_type": "text/markdown", "bytes": base64.StdEncoding.EncodeToString(readable),
				"size_bytes": len(readable), "sha256": sha,
				"complete_references": map[string]any{
					"document_asset_ids":  export.State.CompleteReferences.DocumentAssetIDs,
					"document_thread_ids": export.State.CompleteReferences.DocumentThreadIDs,
				},
				"warnings": []string{},
			})
		default:
			http.NotFound(w, request)
		}
	}))
	registerIntegrationServerCleanup(t, runtime)

	databaseURL := newIntegrationDatabase(t)
	if poolMaxConns > 0 {
		parsed, err := url.Parse(databaseURL)
		if err != nil {
			t.Fatal(err)
		}
		query := parsed.Query()
		query.Set("pool_max_conns", strconv.Itoa(poolMaxConns))
		parsed.RawQuery = query.Encode()
		databaseURL = parsed.String()
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	artifactRoot := prepareTemplateAppCatalog(t, pool)
	broker := realtime.NewBroker(64)
	appOptions := append(riverTestOnlyOptions(), withRealtimeBroker(broker), skipping(app.SkillInstall),
		withDocumentTextNormalizer(fixtureTextNormalizer{}))
	if runtimeOptions.jobPollInterval > 0 {
		appOptions = append(appOptions, withConfig(func(cfg *config.Config) { cfg.Jobs.DocumentCommentSweepInterval = runtimeOptions.jobPollInterval }))
	}
	if runtimeOptions.wikiCandidateGenerator != nil {
		appOptions = append(appOptions, withWikiCandidateGenerator(runtimeOptions.wikiCandidateGenerator))
	}
	if runtimeOptions.disableRoomDocumentWorkers {
		appOptions = append(appOptions, skipping(app.RoomDocumentJobs))
	}
	appOptions = append(appOptions, runtimeOptions.appOptions...)
	application, err := newTestApp(ctx, config.ForTest(func(c *config.Config) {
		c.DatabaseURL = databaseURL
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
		c.TeamHubInternalToken = teamHubInternalToken
		c.NodeServicesInternalToken = nodeServicesInternalToken
		c.AgentRunTokenSecret = agentRunTokenSecret
		c.ArtifactStorageRoot = artifactRoot
		c.ArtifactMaxBytes = 1 << 20
		c.RoomDocument.RuntimeURL = runtime.URL
		c.RoomDocument.AssetUploadStagingRetention = stagingRetention
		c.RoomDocument.AssetGCGrace = assetGCGrace
		c.RoomDocument.AssetQuotas = config.AssetQuotas{
			MaxAssetBytes:       runtimeOptions.assetMaxBytes,
			MaxDocumentBytes:    runtimeOptions.assetDocumentMaxBytes,
			MaxDocumentObjects:  runtimeOptions.assetDocumentMaxObjects,
			MaxTenantBytes:      runtimeOptions.assetTenantMaxBytes,
			MaxTenantObjects:    runtimeOptions.assetTenantMaxObjects,
			StorageReserveBytes: runtimeOptions.assetStorageReserveBytes,
		}
	}), appOptions...)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(application.Close)
	server := httptest.NewServer(application.Handler())
	registerIntegrationServerCleanup(t, server)
	env := &testEnv{
		t: t, databaseURL: databaseURL, pool: pool, server: server,
		artifactRoot: artifactRoot, broker: broker,
		documentRuntimeURL: runtime.URL, documentRuntimeToken: runtimeToken,
	}
	return env, env.login("alice", alicePassword)
}
