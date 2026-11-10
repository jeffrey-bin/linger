package externalsource

import (
	"context"
	"errors"
	"slices"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/secretbox"
)

// managedAuthScheme is the auth scheme of a curated app's Composio-managed
// auth config.
const managedAuthScheme = "OAUTH2"

// appAuth returns the auth config scheme of a curated app and whether
// Composio manages it. A custom config carries no credentials: its connect
// link collects whatever the user provides.
func appAuth(appKey string) (scheme string, managed bool) {
	index := slices.IndexFunc(curatedApps, func(app ExternalApp) bool { return app.Key == appKey })
	if index >= 0 && curatedApps[index].customAuthScheme != "" {
		return curatedApps[index].customAuthScheme, false
	}
	return managedAuthScheme, true
}

type managedCatalog struct {
	client *composio.Client
	// keyFromEnvironment is fixed at start; otherwise the key is the one saved
	// in composio_settings, sealed by keyBox and loaded once at start.
	keyFromEnvironment bool
	keyBox             *secretbox.Box
	// authConfigs caches each toolkit's auth config ID for the current key;
	// authLocks serialize the find-or-create of one toolkit. A key change
	// clears the cache and bumps authKeyGeneration, so a lookup that started
	// with the previous key is not cached.
	authMu            sync.Mutex
	authConfigs       map[string]string
	authLocks         map[string]*sync.Mutex
	authKeyGeneration int
}

// ConfigureManagedApps runs before workers start. Without it, or while the
// client has no API key, TeamHub has no connected apps: every app is
// unavailable and every connection operation that calls Composio fails as
// unavailable. keyBox is nil when the deployment cannot save a key.
func (s *Service) ConfigureManagedApps(ctx context.Context, client *composio.Client, keyBox *secretbox.Box) error {
	if client == nil {
		return ErrInvalid
	}
	s.managed = &managedCatalog{
		client: client, keyFromEnvironment: client.Configured(), keyBox: keyBox,
		authConfigs: map[string]string{}, authLocks: map[string]*sync.Mutex{},
	}
	client.SetConnectionAuthority(s.resolveUpstreamBinding)
	// TeamHub runs as a single instance, so the instance that saves a key
	// updates its own client and the saved key never needs a reload. A key
	// that cannot be read leaves apps unavailable until it is saved again.
	if err := s.loadManagedKey(ctx); err != nil {
		s.logger.Error("load Composio API key", "error", err)
	}
	return nil
}

func (s *Service) resolveUpstreamBinding(ctx context.Context, upstreamID string) (composio.ConnectionBinding, error) {
	var binding composio.ConnectionBinding
	if s.managed == nil {
		return binding, composio.ErrConnectionScope
	}
	err := s.pool.QueryRow(ctx, `SELECT user_id,toolkit_slug,auth_config_id FROM external_connection_upstreams WHERE upstream_id=$1`, upstreamID).Scan(&binding.UserID, &binding.ToolkitSlug, &binding.AuthConfigID)
	if errors.Is(err, pgx.ErrNoRows) {
		return binding, composio.ErrConnectionScope
	}
	return binding, err
}

// ensureAuthConfig returns the auth config every connection of appKey uses,
// finding it in Composio by its stable name or creating it on first use. The
// ID is cached only in this process; replicas serialize the lookup through an
// advisory lock, so they create it once. A create whose result is unknown is not
// cached: the next call finds it by name, or creates it again, which at worst
// leaves an unused duplicate in Composio.
func (s *Service) ensureAuthConfig(ctx context.Context, appKey string) (string, error) {
	toolkit := toolkitForApp(appKey)
	scheme, managed := appAuth(appKey)
	catalog := s.managed
	catalog.authMu.Lock()
	id, lock := catalog.authConfigs[toolkit], catalog.authLocks[toolkit]
	if lock == nil {
		lock = &sync.Mutex{}
		catalog.authLocks[toolkit] = lock
	}
	catalog.authMu.Unlock()
	if id != "" {
		return id, nil
	}
	lock.Lock()
	defer lock.Unlock()
	catalog.authMu.Lock()
	id, generation := catalog.authConfigs[toolkit], catalog.authKeyGeneration
	catalog.authMu.Unlock()
	if id != "" {
		return id, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	var remote composio.AuthConfig
	// Another TeamHub replica may find or create the same auth config, so the
	// lookup is serialized across processes and the second one finds it.
	err := s.withManagedLock(ctx, "auth:"+toolkit, func() error {
		name := catalog.client.AuthConfigName(toolkit, scheme)
		var found bool
		var err error
		if remote, found, err = catalog.client.FindAuthConfig(ctx, toolkit, name, scheme, managed); err != nil || found {
			return err
		}
		if remote, err = catalog.client.CreateAuthConfig(ctx, toolkit, name, scheme, managed); err != nil {
			// Composio refused the creation outright, so the app is unavailable.
			if code, ok := composio.ErrorStatus(err); ok && code >= 400 && code < 500 && code != 408 && code != 409 && code != 429 {
				return errors.Join(ErrUnavailable, err)
			}
		}
		return err
	})
	if err != nil {
		return "", err
	}
	catalog.authMu.Lock()
	defer catalog.authMu.Unlock()
	if generation != catalog.authKeyGeneration {
		return "", errors.Join(ErrUnavailable, errors.New("the Composio API key changed during the lookup"))
	}
	catalog.authConfigs[toolkit] = remote.ID
	return remote.ID, nil
}

// withManagedLock runs run under a PostgreSQL advisory lock named key, held on
// one pooled connection for the duration of run.
func (s *Service) withManagedLock(ctx context.Context, key string, run func() error) error {
	if s.pool == nil {
		return run()
	}
	conn, err := s.pool.Acquire(ctx)
	if err != nil {
		return err
	}
	key = "managed-app:" + key
	if _, err = conn.Exec(ctx, `SELECT pg_advisory_lock(hashtextextended($1,0))`, key); err != nil {
		closeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = conn.Hijack().Close(closeCtx)
		return err
	}
	defer func() {
		unlockCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		var unlocked bool
		if err := conn.QueryRow(unlockCtx, `SELECT pg_advisory_unlock(hashtextextended($1,0))`, key).Scan(&unlocked); err != nil || !unlocked {
			_ = conn.Hijack().Close(unlockCtx)
			return
		}
		conn.Release()
	}()
	return run()
}

// setManagedKey switches the client to key. Auth config IDs found with the
// previous key belong to another Composio project.
func (s *Service) setManagedKey(key string) {
	s.managed.client.SetAPIKey(key)
	s.managed.authMu.Lock()
	s.managed.authConfigs = map[string]string{}
	s.managed.authKeyGeneration++
	s.managed.authMu.Unlock()
}

func (s *Service) createManagedLinkInTx(ctx context.Context, tx pgx.Tx, accountID, toolkit, configID string) (composio.Link, error) {
	link, err := s.managed.client.CreateConnectionLink(ctx, configID, accountID)
	if err != nil {
		return composio.Link{}, err
	}
	_, err = tx.Exec(ctx, `INSERT INTO external_connection_upstreams(upstream_id,account_id,user_id,toolkit_slug,auth_config_id) VALUES($1,$2,$3,$4,$5)`, link.ConnectedAccountID, accountID, s.managed.client.UserIDForAccount(accountID), toolkit, configID)
	return link, err
}

// toolkitForApp maps a curated app key to its Composio toolkit slug.
func toolkitForApp(key string) string {
	switch key {
	case "discord":
		return "discordbot"
	case "google_calendar":
		return "googlecalendar"
	case "google_meet":
		return "googlemeet"
	case "higgsfield":
		return "higgsfield_mcp"
	case "granola":
		return "granola_mcp"
	// Composio has no calendar-only Outlook toolkit; its Outlook toolkit covers both.
	case "outlook_calendar":
		return "outlook"
	default:
		return key
	}
}
