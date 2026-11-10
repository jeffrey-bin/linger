package collaboration

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"regexp"

	"github.com/jackc/pgx/v5"
	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

var historyTokenPattern = regexp.MustCompile(`^room_share_[A-Za-z0-9_-]{43}$`)

// CreateRoomHistoryShare snapshots the Room's conversation into a shared
// history that anyone with the returned token can read.
func (s *Service) CreateRoomHistoryShare(ctx context.Context, accountID, roomID string, input httpapi.CreateRoomHistoryShare) (httpapi.RoomHistoryShare, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return httpapi.RoomHistoryShare{}, err
	}
	defer tx.Rollback(ctx)
	q := store.New(tx)
	room, err := q.GetRoomForAccount(ctx, store.GetRoomForAccountParams{ID: roomID, AccountID: textValue(accountID)})
	if err != nil {
		return httpapi.RoomHistoryShare{}, err
	}
	if room.DeletionStartedAt.Valid {
		return httpapi.RoomHistoryShare{}, pgx.ErrNoRows
	}
	if err = rejectImmutableRoomSubtype(ctx, q, roomID); err != nil {
		return httpapi.RoomHistoryShare{}, err
	}
	membership, err := q.GetHumanRoomMembershipForShare(ctx, store.GetHumanRoomMembershipForShareParams{RoomID: roomID, AccountID: accountID})
	if err != nil {
		return httpapi.RoomHistoryShare{}, err
	}
	if membership.Role != "owner" {
		return httpapi.RoomHistoryShare{}, ErrRoomOwnerRequired
	}
	if !roomParticipationAllowed(ctx, q, accountID, roomID) {
		return httpapi.RoomHistoryShare{}, ErrRoomParticipationLeft
	}
	token, hash, err := newHistoryToken()
	if err != nil {
		return httpapi.RoomHistoryShare{}, err
	}
	result := httpapi.RoomHistoryShare{Id: idgen.New("room_share"), RoomName: room.Name, SnapshotRoomSeq: room.NextRoomSeq, Token: &token}
	version := ""
	if input.WebVersion != nil {
		version = *input.WebVersion
	}
	createdAt, err := q.CreateRoomHistoryShare(ctx, store.CreateRoomHistoryShareParams{
		ID: result.Id, RoomID: roomID, CreatorActorID: membership.ActorID,
		CreatorMembershipEpochID: membership.MembershipEpochID, TokenHash: hash,
		RoomName: room.Name, SnapshotRoomSeq: room.NextRoomSeq, WebVersion: version,
	})
	if err != nil {
		return httpapi.RoomHistoryShare{}, err
	}
	result.CreatedAt = createdAt.Time
	result.MessageCount, err = s.copyRoomHistory(ctx, q, accountID, roomID, result.Id)
	if err != nil {
		return httpapi.RoomHistoryShare{}, err
	}
	if err = q.SetRoomHistoryShareMessageCount(ctx, store.SetRoomHistoryShareMessageCountParams{
		ID: result.Id, MessageCount: int32(result.MessageCount),
	}); err != nil {
		return httpapi.RoomHistoryShare{}, err
	}
	return result, tx.Commit(ctx)
}

// ListRoomHistoryShares lists a Room's shared histories for its owner.
func (s *Service) ListRoomHistoryShares(ctx context.Context, accountID, roomID string) ([]httpapi.RoomHistoryShare, error) {
	authority, err := s.queries.GetRoomOwnerAuthority(ctx, store.GetRoomOwnerAuthorityParams{ID: roomID, AccountID: textValue(accountID)})
	if err != nil {
		return nil, err
	}
	if authority.Role != "owner" {
		return nil, ErrRoomOwnerRequired
	}
	rows, err := s.queries.ListRoomHistoryShares(ctx, roomID)
	if err != nil {
		return nil, err
	}
	items := make([]httpapi.RoomHistoryShare, 0, len(rows))
	for _, row := range rows {
		items = append(items, httpapi.RoomHistoryShare{
			Id: row.ID, RoomName: row.RoomName, CreatedAt: row.CreatedAt.Time,
			MessageCount: int(row.MessageCount), SnapshotRoomSeq: row.SnapshotRoomSeq, Revoked: row.Revoked,
		})
	}
	return items, nil
}

// RevokeRoomHistoryShare stops a shared history's link from reading it.
func (s *Service) RevokeRoomHistoryShare(ctx context.Context, accountID, roomID, shareID string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	q := store.New(tx)
	authority, err := q.GetRoomOwnerAuthority(ctx, store.GetRoomOwnerAuthorityParams{ID: roomID, AccountID: textValue(accountID)})
	if err != nil {
		return err
	}
	if authority.Role != "owner" {
		return ErrRoomOwnerRequired
	}
	revoked, err := q.RevokeRoomHistoryShare(ctx, store.RevokeRoomHistoryShareParams{RoomID: roomID, ID: shareID})
	if err != nil {
		return err
	}
	if revoked == 0 {
		return pgx.ErrNoRows
	}
	return tx.Commit(ctx)
}

// IssueRoomHistoryShareLink replaces a live shared history's token, so only
// the new link reads it.
func (s *Service) IssueRoomHistoryShareLink(ctx context.Context, accountID, roomID, shareID string) (httpapi.RoomHistoryShare, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return httpapi.RoomHistoryShare{}, err
	}
	defer tx.Rollback(ctx)
	q := store.New(tx)
	room, err := q.GetRoomForAccount(ctx, store.GetRoomForAccountParams{ID: roomID, AccountID: textValue(accountID)})
	if err != nil {
		return httpapi.RoomHistoryShare{}, err
	}
	if room.DeletionStartedAt.Valid || !roomParticipationAllowed(ctx, q, accountID, roomID) {
		return httpapi.RoomHistoryShare{}, ErrRoomParticipationLeft
	}
	authority, err := q.GetRoomOwnerAuthority(ctx, store.GetRoomOwnerAuthorityParams{ID: roomID, AccountID: textValue(accountID)})
	if err != nil {
		return httpapi.RoomHistoryShare{}, err
	}
	if authority.Role != "owner" {
		return httpapi.RoomHistoryShare{}, ErrRoomOwnerRequired
	}
	token, hash, err := newHistoryToken()
	if err != nil {
		return httpapi.RoomHistoryShare{}, err
	}
	row, err := q.RotateRoomHistoryShareToken(ctx, store.RotateRoomHistoryShareTokenParams{
		TokenHash: hash, ID: shareID, RoomID: roomID,
	})
	if err != nil {
		return httpapi.RoomHistoryShare{}, err
	}
	result := httpapi.RoomHistoryShare{
		Id: row.ID, RoomName: row.RoomName, CreatedAt: row.CreatedAt.Time,
		MessageCount: int(row.MessageCount), SnapshotRoomSeq: row.SnapshotRoomSeq, Token: &token,
	}
	return result, tx.Commit(ctx)
}

// HistoryPage is one page of a shared history read through its token.
type HistoryPage struct {
	Share     httpapi.RoomHistoryShare
	Items     []json.RawMessage
	NextAfter int64
}

// HistoryAsset is an image stored in a shared history.
type HistoryAsset struct {
	MediaType string
	Content   []byte
}

// ReadRoomHistory reads the page of a shared history after position after.
// It reports pgx.ErrNoRows for an unknown, revoked or orphaned token.
func (s *Service) ReadRoomHistory(ctx context.Context, token string, after int64) (HistoryPage, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return HistoryPage{}, err
	}
	defer tx.Rollback(ctx)
	q := store.New(tx)
	share, err := authorizedHistory(ctx, q, token)
	if err != nil {
		return HistoryPage{}, err
	}
	rows, err := q.ListRoomHistoryShareMessages(ctx, store.ListRoomHistoryShareMessagesParams{ShareID: share.Id, AfterPosition: after})
	if err != nil {
		return HistoryPage{}, err
	}
	items := make([]json.RawMessage, 0, len(rows))
	for _, row := range rows {
		items = append(items, json.RawMessage(row))
	}
	next := int64(0)
	if after+int64(len(items)) < int64(share.MessageCount) {
		next = after + int64(len(items))
	}
	return HistoryPage{Share: share, Items: items, NextAfter: next}, nil
}

// ReadRoomHistoryAsset reads one image of a shared history through its token.
func (s *Service) ReadRoomHistoryAsset(ctx context.Context, token, assetID string) (HistoryAsset, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return HistoryAsset{}, err
	}
	defer tx.Rollback(ctx)
	q := store.New(tx)
	share, err := authorizedHistory(ctx, q, token)
	if err != nil {
		return HistoryAsset{}, err
	}
	asset, err := q.GetRoomHistoryShareAsset(ctx, store.GetRoomHistoryShareAssetParams{ShareID: share.Id, ID: assetID})
	if err != nil {
		return HistoryAsset{}, err
	}
	return HistoryAsset{MediaType: asset.MediaType, Content: asset.Content}, nil
}

func authorizedHistory(ctx context.Context, q *store.Queries, token string) (httpapi.RoomHistoryShare, error) {
	if !historyTokenPattern.MatchString(token) {
		return httpapi.RoomHistoryShare{}, pgx.ErrNoRows
	}
	hash := sha256.Sum256([]byte(token))
	row, err := q.GetAuthorizedRoomHistoryShare(ctx, hash[:])
	if err != nil {
		return httpapi.RoomHistoryShare{}, err
	}
	return httpapi.RoomHistoryShare{
		Id: row.ID, RoomName: row.RoomName, CreatedAt: row.CreatedAt.Time,
		MessageCount: int(row.MessageCount), SnapshotRoomSeq: row.SnapshotRoomSeq,
	}, nil
}

func newHistoryToken() (string, []byte, error) {
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		return "", nil, err
	}
	token := "room_share_" + base64.RawURLEncoding.EncodeToString(secret)
	hash := sha256.Sum256([]byte(token))
	return token, hash[:], nil
}
