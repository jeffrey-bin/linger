package account

// The human Account profile shown in Settings: name, bio, organization, and
// images. The name is the Human actor's display_name; every other field is
// stored on the accounts row the actor points to.
//
// Lock order: a profile write updates the accounts row that every Account
// delivery allocation also locks, so it is the last write of its transaction
// before commit apart from job enqueueing.

import (
	"context"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

const (
	MaxNameBytes         = 120
	MaxBioBytes          = 2000
	MaxOrganizationBytes = 200
)

// Profile errors: a request that fails validation, and an Account or actor
// without a Human profile.
var (
	ErrProfileInvalid  = errors.New("invalid account profile request")
	ErrProfileNotFound = errors.New("account profile not found")
)

// Fields are the generated values a Profile run proposes.
type Fields struct {
	Name, Bio, Organization string
}

type Profile struct {
	AvatarImage, BackgroundImage                             string
	Name, Bio, Organization, Email                           string
	NameUserManaged, BioUserManaged, OrganizationUserManaged bool
	UpdatedAt                                                *time.Time
}

type Patch struct {
	AvatarImage, BackgroundImage *string
	Name, Bio, Organization      *string
}

type record struct {
	AvatarImage, BackgroundImage                             string
	Name, Bio, Organization                                  string
	NameUserManaged, BioUserManaged, OrganizationUserManaged bool
	UpdatedAt                                                *time.Time
}

// ProfileService reads and patches human Account profiles.
type ProfileService struct{ pool *pgxpool.Pool }

// NewProfileService returns a ProfileService backed by pool.
func NewProfileService(pool *pgxpool.Pool) *ProfileService { return &ProfileService{pool: pool} }

// Get reads the signed-in Account's profile and reports email as its Email.
func (s *ProfileService) Get(ctx context.Context, accountID, tenantID, email string) (Profile, error) {
	actorID, err := s.humanActorID(ctx, accountID, tenantID)
	if err != nil {
		return Profile{}, err
	}
	profile, err := s.GetActor(ctx, tenantID, actorID)
	if err != nil {
		return Profile{}, err
	}
	profile.Email = email
	return profile, nil
}

// GetActor reads one Human actor's profile; the result has no Email.
func (s *ProfileService) GetActor(ctx context.Context, tenantID, actorID string) (Profile, error) {
	current, err := load(ctx, s.pool, tenantID, actorID)
	if err != nil {
		return Profile{}, err
	}
	return current.profile(""), nil
}

// Patch applies a Patch to the signed-in Account's profile and reports email as
// its Email.
func (s *ProfileService) Patch(ctx context.Context, accountID, tenantID, email string, patch Patch) (Profile, error) {
	actorID, err := s.humanActorID(ctx, accountID, tenantID)
	if err != nil {
		return Profile{}, err
	}
	profile, err := s.PatchActor(ctx, tenantID, actorID, patch)
	if err != nil {
		return Profile{}, err
	}
	profile.Email = email
	return profile, nil
}

// PatchActor applies a Patch to one Human actor's profile; the result has no Email.
func (s *ProfileService) PatchActor(ctx context.Context, tenantID, actorID string, patch Patch) (Profile, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Profile{}, err
	}
	defer tx.Rollback(ctx)
	current, err := load(ctx, tx, tenantID, actorID)
	if err != nil {
		return Profile{}, err
	}
	next, err := applyPatch(current, patch)
	if err != nil {
		return Profile{}, err
	}
	if next.Name != current.Name {
		if _, err = tx.Exec(ctx, `UPDATE actors SET display_name=$3 WHERE id=$1 AND tenant_id=$2 AND kind='human'`, actorID, tenantID, next.Name); err != nil {
			return Profile{}, err
		}
		if err = renameHuman(ctx, tx, tenantID, actorID, next.Name); err != nil {
			return Profile{}, err
		}
	}
	if err = save(ctx, tx, tenantID, actorID, next); err != nil {
		return Profile{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Profile{}, err
	}
	saved, err := load(ctx, s.pool, tenantID, actorID)
	if err != nil {
		return Profile{}, err
	}
	return saved.profile(""), nil
}

// ApplyGenerated fills the fields the user has not edited by hand. It locks the
// Account row, so callers run it after their Room, Document and delivery work.
func ApplyGenerated(ctx context.Context, tx pgx.Tx, tenantID, actorID string, generated Fields) error {
	current, err := load(ctx, tx, tenantID, actorID)
	if err != nil {
		return err
	}
	next := mergeGenerated(current, generated)
	if next.Name != current.Name {
		tag, err := tx.Exec(ctx, `UPDATE actors SET display_name=$3 WHERE id=$1 AND tenant_id=$2 AND kind='human' AND length($3) BETWEEN 1 AND 120`, actorID, tenantID, next.Name)
		if err != nil {
			return err
		}
		if tag.RowsAffected() > 0 {
			if err = renameHuman(ctx, tx, tenantID, actorID, next.Name); err != nil {
				return err
			}
		}
	}
	return save(ctx, tx, tenantID, actorID, next)
}

// AnotherMeName is the name an Another Me carries after its Human.
func AnotherMeName(humanName string) string {
	return humanName + "'s Another Me"
}

// AnotherMeDescription is the description an Another Me carries after its Human.
func AnotherMeDescription(humanName string) string {
	return "Private delegate for " + humanName
}

// renameHuman follows a Human's new name through their Another Me and tells
// the Tenant's browsers, which show the name in the directory, Room members
// and Chat rows.
func renameHuman(ctx context.Context, tx pgx.Tx, tenantID, humanActorID, after string) error {
	if err := renameAnotherMe(ctx, tx, tenantID, humanActorID, after); err != nil {
		return err
	}
	return PublishTenantChange(ctx, store.New(tx), tenantID, "tenant.directory.changed")
}

// renameAnotherMe keeps the Human's Another Me named after them when their
// name changes. Any name or description still in its generated form follows,
// even one left behind by an earlier rename; one the user edited by hand, or a
// new name too long for an Actor, stays. A changed description advances the
// configuration revision, as every profile change does.
func renameAnotherMe(ctx context.Context, tx pgx.Tx, tenantID, humanActorID, after string) error {
	const anotherMes = `SELECT actor_id FROM agent_registrations
    WHERE tenant_id=$1 AND agent_type='anotherme' AND represented_human_actor_id=$2`
	if _, err := tx.Exec(ctx, `UPDATE actors SET display_name=$3
WHERE tenant_id=$1 AND kind='agent' AND display_name<>$3 AND length($3) <= 120
  AND right(display_name, length($4)) = $4
  AND id IN (`+anotherMes+`)`, tenantID, humanActorID, AnotherMeName(after), AnotherMeName("")); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `UPDATE agent_registrations
SET description=$3, configuration_revision=configuration_revision+1, updated_at=now()
WHERE tenant_id=$1 AND status='active' AND description<>$3
  AND left(description, length($4)) = $4
  AND actor_id IN (`+anotherMes+`)`, tenantID, humanActorID, AnotherMeDescription(after), AnotherMeDescription(""))
	return err
}

func mergeGenerated(current record, generated Fields) record {
	next := current
	if !current.NameUserManaged {
		if name, ok := normalizedName(generated.Name); ok {
			next.Name = name
		}
	}
	if !current.BioUserManaged {
		if bio, ok := normalizedOptionalText(generated.Bio, MaxBioBytes); ok {
			next.Bio = bio
		}
	}
	if !current.OrganizationUserManaged {
		if organization, ok := normalizedOptionalText(generated.Organization, MaxOrganizationBytes); ok {
			next.Organization = organization
		}
	}
	return next
}

func applyPatch(current record, patch Patch) (record, error) {
	if patch.Name == nil && patch.Bio == nil && patch.Organization == nil && patch.AvatarImage == nil && patch.BackgroundImage == nil {
		return record{}, ErrProfileInvalid
	}
	next := current
	for _, field := range []struct {
		input  *string
		output *string
	}{{patch.AvatarImage, &next.AvatarImage}, {patch.BackgroundImage, &next.BackgroundImage}} {
		if field.input != nil {
			if !validProfileImage(*field.input) {
				return record{}, ErrProfileInvalid
			}
			*field.output = *field.input
		}
	}
	if patch.Name != nil {
		name, ok := normalizedName(*patch.Name)
		if !ok {
			return record{}, ErrProfileInvalid
		}
		next.Name = name
		next.NameUserManaged = true
	}
	if patch.Bio != nil {
		if !validField(*patch.Bio, MaxBioBytes) {
			return record{}, ErrProfileInvalid
		}
		next.Bio = *patch.Bio
		next.BioUserManaged = true
	}
	if patch.Organization != nil {
		if !validField(*patch.Organization, MaxOrganizationBytes) {
			return record{}, ErrProfileInvalid
		}
		next.Organization = *patch.Organization
		next.OrganizationUserManaged = true
	}
	return next, nil
}

func normalizedName(value string) (string, bool) {
	name := strings.TrimSpace(value)
	return name, name != "" && utf8.ValidString(name) && len(name) <= MaxNameBytes
}

func normalizedOptionalText(value string, maximum int) (string, bool) {
	text := strings.TrimSpace(value)
	return text, text != "" && validField(text, maximum)
}

func validField(value string, maximum int) bool {
	return utf8.ValidString(value) && len(value) <= maximum
}

func (s *ProfileService) humanActorID(ctx context.Context, accountID, tenantID string) (string, error) {
	actor, err := store.New(s.pool).GetHumanActor(ctx, store.GetHumanActorParams{
		TenantID: tenantID, AccountID: pgtype.Text{String: accountID, Valid: true},
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrProfileNotFound
	}
	return actor.ID, err
}

type rowQuerier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

func load(ctx context.Context, db rowQuerier, tenantID, actorID string) (record, error) {
	var current record
	err := db.QueryRow(ctx, `
		SELECT actor.display_name,
		       coalesce(account.profile_avatar_image, ''),
		       coalesce(account.profile_background_image, ''),
		       coalesce(account.profile_bio, ''),
		       coalesce(account.profile_organization, ''),
		       coalesce(account.profile_name_user_managed, false),
		       coalesce(account.profile_bio_user_managed, false),
		       coalesce(account.profile_organization_user_managed, false),
		       account.profile_updated_at
		FROM actors actor
		LEFT JOIN accounts account ON account.id=actor.account_id
		WHERE actor.id=$1 AND actor.tenant_id=$2 AND actor.kind='human'`, actorID, tenantID).Scan(
		&current.Name, &current.AvatarImage, &current.BackgroundImage, &current.Bio, &current.Organization, &current.NameUserManaged, &current.BioUserManaged, &current.OrganizationUserManaged, &current.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return record{}, ErrProfileNotFound
	}
	return current, err
}

// save writes the profile onto the Human's Account. A Human without an
// Account has nowhere to keep a profile.
func save(ctx context.Context, tx pgx.Tx, tenantID, actorID string, value record) error {
	tag, err := tx.Exec(ctx, `
		UPDATE accounts account SET
			profile_avatar_image=$3,
			profile_background_image=$4,
			profile_bio=$5,
			profile_organization=$6,
			profile_name_user_managed=$7,
			profile_bio_user_managed=$8,
			profile_organization_user_managed=$9,
			profile_updated_at=now()
		FROM actors actor
		WHERE actor.id=$1 AND actor.tenant_id=$2 AND actor.kind='human' AND account.id=actor.account_id`,
		actorID, tenantID, value.AvatarImage, value.BackgroundImage, value.Bio, value.Organization,
		value.NameUserManaged, value.BioUserManaged, value.OrganizationUserManaged,
	)
	if err == nil && tag.RowsAffected() == 0 {
		return ErrProfileNotFound
	}
	return err
}

func (r record) profile(email string) Profile {
	return Profile{
		AvatarImage: r.AvatarImage, BackgroundImage: r.BackgroundImage,
		Name: r.Name, Bio: r.Bio, Organization: r.Organization,
		NameUserManaged: r.NameUserManaged, BioUserManaged: r.BioUserManaged,
		OrganizationUserManaged: r.OrganizationUserManaged, Email: email,
		UpdatedAt: r.UpdatedAt,
	}
}
