package integration_test

import (
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/app"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/documenttext"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/externalsource"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/permissionreview"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/personalinsight"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/personalprofile"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/proactive"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/realtime"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/skill"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicemedia"
)

type uploadedDocumentRef struct {
	ID             string `json:"id"`
	CurrentVersion struct {
		ID string `json:"id"`
	} `json:"current_version"`
}

type agentSkillRegistrationResponse struct {
	Name            string `json:"name"`
	SkillID         string `json:"skill_id"`
	ManifestVersion string `json:"manifest_version"`
	Description     string `json:"description"`
}

func agentSkillRegistrationsByID(bindings []agentSkillRegistrationResponse) map[string]agentSkillRegistrationResponse {
	result := make(map[string]agentSkillRegistrationResponse, len(bindings))
	for _, binding := range bindings {
		result[binding.SkillID] = binding
	}
	return result
}

func hasOfficeDefaultSkillRegistrations(bindings map[string]agentSkillRegistrationResponse) bool {
	for name, version := range map[string]string{"docx": "1.0.0", "pdf": "1.0.0", "pptx": "1.0.2", "xlsx": "1.0.0"} {
		binding := bindings["linger_builtin_"+name]
		if binding.Name != name || binding.ManifestVersion != version {
			return false
		}
	}
	return true
}

// lev8-search is a paid CLI, so no Agent type gets it by default.
func lacksLev8SearchSkillRegistration(bindings map[string]agentSkillRegistrationResponse) bool {
	_, ok := bindings["simplexai_lev8_search"]
	return !ok
}

func uploadTestDocument(
	t *testing.T, env *testEnv, client *http.Client,
	key, filename, representationFormat, mediaType, content string,
) uploadedDocumentRef {
	t.Helper()
	status, _, body := requestUnifiedDocumentMultipart(
		t, env, client, "/v0/tenants/"+acmeTenant+"/documents/uploads", key,
		map[string]string{
			"filename": filename, "representation_format": representationFormat, "media_type": mediaType,
		}, filename, []byte(content),
	)
	if status != http.StatusCreated {
		t.Fatalf("upload test Document status=%d body=%s", status, body)
	}
	var document uploadedDocumentRef
	decode(t, body, &document)
	return document
}

const integrationSkillObjectMaxBytes = 32 << 20

var (
	skillArtifactOnce sync.Once
	skillArtifactRoot string
	skillArtifactErr  error
)

func ensureIntegrationSkillArtifactRoot() (string, error) {
	skillArtifactOnce.Do(func() {
		skillArtifactRoot, skillArtifactErr = os.MkdirTemp("", "teamhub-integration-skills-")
	})
	return skillArtifactRoot, skillArtifactErr
}

func integrationSkillArtifactRoot() string {
	root, err := ensureIntegrationSkillArtifactRoot()
	if err != nil {
		panic("integration Skill artifact store: " + err.Error())
	}
	return root
}

// integrationArtifactRoot returns an object root private to one test. On macOS
// the whole template directory is cloned with one APFS clonefile call. Elsewhere,
// or when cloning fails, each entry is a hard link to the template Skill object.
// Either way the test reads the same bytes without sharing the directory.
// LocalStore publishes by rename and never writes an existing object in place,
// and Delete only unlinks, so a private copy or link cannot change or remove the
// template object.
func integrationArtifactRoot(t *testing.T) string {
	t.Helper()
	template := integrationSkillArtifactRoot()
	dir := t.TempDir()
	root := filepath.Join(dir, "clone")
	if err := cloneIntegrationArtifactRoot(template, root); err == nil {
		return root
	}
	root = dir
	entries, err := os.ReadDir(template)
	if err != nil {
		t.Fatalf("read template Skill artifact root: %v", err)
	}
	for _, entry := range entries {
		source := filepath.Join(template, entry.Name())
		target := filepath.Join(root, entry.Name())
		if err := os.Link(source, target); err != nil {
			if err := copyIntegrationArtifact(source, target); err != nil {
				t.Fatalf("copy template Skill artifact %s: %v", entry.Name(), err)
			}
		}
	}
	return root
}

// copyIntegrationArtifact is the fallback when the template and test root cannot
// share a filesystem or hard links are unsupported.
func copyIntegrationArtifact(source, target string) error {
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return err
	}
	return out.Close()
}

func removeIntegrationSkillArtifactRoot() error {
	if skillArtifactRoot == "" {
		return nil
	}
	err := os.RemoveAll(skillArtifactRoot)
	skillArtifactRoot = ""
	return err
}

func installTemplateSkills(ctx context.Context, databaseURL string) error {
	artifactRoot, err := ensureIntegrationSkillArtifactRoot()
	if err != nil {
		return err
	}
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	objects, err := artifactstore.NewLocalStore(artifactRoot, integrationSkillObjectMaxBytes)
	if err != nil {
		return err
	}
	return skill.Ensure(ctx, pool, objects)
}

// riverTestPollInterval keeps River job hops fast in tests that build their own
// River client; config.ForTest gives the App the same poll.
const riverTestPollInterval = 25 * time.Millisecond

// riverTestSoftStopTimeout bounds how long Close waits for a job a test left
// running before River cancels it; production waits ten seconds.
const riverTestSoftStopTimeout = 2 * time.Second

// appSetup collects how a test builds and starts its App: the fakes it injects,
// the background work it drives itself, and the pacing it shortens.
type appSetup struct {
	deps      app.Deps
	skip      []app.Worker
	configure []func(*config.Config)
}

type appOption func(*appSetup)

func withDeps(edit func(*app.Deps)) appOption {
	return func(setup *appSetup) { edit(&setup.deps) }
}

func withConfig(edit func(*config.Config)) appOption {
	return func(setup *appSetup) { setup.configure = append(setup.configure, edit) }
}

// skipping leaves workers to the test, which drives their jobs itself.
func skipping(workers ...app.Worker) appOption {
	return func(setup *appSetup) {
		for _, worker := range workers {
			if !slices.Contains(setup.skip, worker) {
				setup.skip = append(setup.skip, worker)
			}
		}
	}
}

// starting starts workers an earlier option skipped.
func starting(workers ...app.Worker) appOption {
	return func(setup *appSetup) {
		setup.skip = slices.DeleteFunc(setup.skip, func(worker app.Worker) bool { return slices.Contains(workers, worker) })
	}
}

func withAgentManagement(management roomagent.AgentManagement) appOption {
	return withDeps(func(deps *app.Deps) { deps.AgentManagement = management })
}

func withLocalComputers(computers roomagent.LocalComputerManagement) appOption {
	return withDeps(func(deps *app.Deps) { deps.LocalComputers = computers })
}

func withComposio(provider externalsource.Provider) appOption {
	return withDeps(func(deps *app.Deps) { deps.Composio = provider })
}

func withVoiceMedia(media voicemedia.Plane) appOption {
	return withDeps(func(deps *app.Deps) { deps.VoiceMedia = media })
}

func withPersonalProfileGenerator(generator personalprofile.Generator) appOption {
	return withDeps(func(deps *app.Deps) { deps.PersonalProfile = generator })
}

func withPersonalInsightGenerator(generator personalinsight.Generator) appOption {
	return withDeps(func(deps *app.Deps) { deps.PersonalInsight = generator })
}

func withWikiCandidateGenerator(generator document.WikiCandidateGenerator) appOption {
	return withDeps(func(deps *app.Deps) { deps.WikiCandidates = generator })
}

func withDocumentTextNormalizer(normalizer documenttext.Normalizer) appOption {
	return withDeps(func(deps *app.Deps) { deps.DocumentTextNormalizer = normalizer })
}

func withProactiveEventJudge(judge proactive.EventJudge) appOption {
	return withDeps(func(deps *app.Deps) { deps.ProactiveEventJudge = judge })
}

func withPermissionJudge(judge permissionreview.Judge) appOption {
	return withDeps(func(deps *app.Deps) { deps.PermissionJudge = judge })
}

func withRealtimeBroker(broker *realtime.Broker) appOption {
	return withDeps(func(deps *app.Deps) { deps.RealtimeBroker = broker })
}

func withQueryTracer(tracer pgx.QueryTracer) appOption {
	return withDeps(func(deps *app.Deps) { deps.QueryTracer = tracer })
}

func withPasswordVerifier(verify func(password, encoded string) (bool, error)) appOption {
	return withDeps(func(deps *app.Deps) { deps.VerifyPassword = verify })
}

// riverTestOnlyOptions starts River leader maintenance without its staggered
// delay, so tests that rely on a periodic sweep are not at the mercy of a 0-6s
// start-up wait. TEAMHUB_TEST_RIVER_TEST_ONLY=off keeps the production delay to
// prove that an event path does not depend on the sweep starting.
func riverTestOnlyOptions() []appOption {
	if os.Getenv("TEAMHUB_TEST_RIVER_TEST_ONLY") == "off" {
		return nil
	}
	return []appOption{withConfig(func(cfg *config.Config) { cfg.Jobs.RiverTestOnly = true })}
}

// newTestApp builds an App and starts every worker the options do not skip.
func newTestApp(ctx context.Context, cfg config.Config, options ...appOption) (*app.App, error) {
	setup := appSetup{}
	for _, option := range options {
		option(&setup)
	}
	for _, edit := range setup.configure {
		edit(&cfg)
	}
	application, err := app.New(ctx, cfg, setup.deps)
	if err != nil {
		return nil, err
	}
	if err := application.StartWorkers(ctx, setup.skip...); err != nil {
		application.Close()
		return nil, err
	}
	return application, nil
}

// newIntegrationApp builds an App whose background jobs stay off, so the test
// drives each step itself; options start the parts a test observes.
func newIntegrationApp(ctx context.Context, cfg config.Config, options ...appOption) (*app.App, error) {
	if cfg.ArtifactStorageRoot == config.ForTest().ArtifactStorageRoot {
		// Callers pass integrationArtifactRoot(t) so each test owns its object root.
		return nil, errors.New("integration app requires ArtifactStorageRoot from integrationArtifactRoot(t)")
	}
	options = append([]appOption{
		skipping(app.SkillInstall, app.SkillPackageProbe, app.RoomDocumentJobs, app.AgentCredentialSweep,
			app.PersonalWikiJobs, app.JobQueue, app.DocumentTextJobs, app.ReminderJobs),
		withConfig(func(cfg *config.Config) { cfg.Jobs.SoftStopTimeout = riverTestSoftStopTimeout }),
	}, append(riverTestOnlyOptions(), options...)...)
	return newTestApp(ctx, cfg, options...)
}

func countRows(t *testing.T, env *testEnv, query string, arguments ...any) int {
	t.Helper()
	var count int
	if err := env.pool.QueryRow(context.Background(), query, arguments...).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}
