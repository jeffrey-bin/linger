package integration_test

import (
	"fmt"
	"reflect"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

// The resolver-based query is an independent authorization oracle: it lists
// what the Agent reads and what its Human reads. Keep it unchanged when
// modifying the list query.
func TestAgentFileListMatchesAccessResolversAndPagination(t *testing.T) {
	allowParallelIntegrationTest(t)
	db, pool, objects := newUnifiedDocumentSemanticMutationFixture(t)
	ctx := t.Context()
	_, err := db.ExecContext(ctx, `UPDATE agent_registrations SET user_artifact_owner_actor_id='actor_human_a' WHERE actor_id='actor_agent_a';
 INSERT INTO accounts(id,email,password_hash) VALUES('account_scale_owner','scale-owner@example.com','x');
 INSERT INTO actors(id,tenant_id,kind,display_name,account_id) VALUES('actor_scale_owner','tenant_document_a','human','Other owner','account_scale_owner');
 INSERT INTO room_members(room_id,tenant_id,actor_id,role,added_by_actor_id) VALUES
 ('room_document_a','tenant_document_a','actor_agent_a','member','actor_human_a'),
 ('room_document_a','tenant_document_a','actor_human_a','owner','actor_human_a');
 INSERT INTO work_items(id,tenant_id,number,kind,title,created_by_actor_id,updated_by_actor_id) VALUES
 ('item_scale_creator','tenant_document_a',102,'issue','Created','actor_agent_a','actor_agent_a'),
 ('item_scale_grant','tenant_document_a',103,'issue','Granted','actor_scale_owner','actor_scale_owner');
 INSERT INTO work_item_access_grants(work_item_id,tenant_id,actor_id,granted_by_actor_id) VALUES('item_scale_grant','tenant_document_a','actor_agent_a','actor_scale_owner');
 INSERT INTO document_wiki_refreshes(id,tenant_id,wiki_id,generator_agent_actor_id,status)
 VALUES('refresh_scale','tenant_document_a','wiki_document_a','actor_agent_a','staging')`)
	if err != nil {
		t.Fatal(err)
	}
	cases := []string{"agent_owner", "human_owner", "personal", "direct_agent", "direct_human", "revoked_agent", "room", "task_assigned", "task_created", "task_granted", "wiki_source", "wiki_page", "hidden", "multiple", "trashing"}
	for _, name := range cases {
		owner, kind := "actor_scale_owner", "human"
		if name == "agent_owner" {
			owner, kind = "actor_agent_a", "agent"
		}
		if name == "human_owner" || name == "personal" {
			owner = "actor_human_a"
		}
		id := "scale_" + name
		_, err = pool.Exec(ctx, `INSERT INTO documents(id,tenant_id,title,format,owner_actor_id,owner_actor_kind,creator_actor_id,creator_actor_kind,status)
 VALUES($1,'tenant_document_a',$1,'text',$2,$3,$2,$3,'active')`, id, owner, kind)
		if err != nil {
			t.Fatal(err)
		}
		if name == "personal" {
			_, err = pool.Exec(ctx, `INSERT INTO document_placements(id,tenant_id,scope_kind,owner_human_actor_id,node_kind,document_id,sort_key) VALUES($1,'tenant_document_a','personal','actor_human_a','document',$2,$1)`, "placement_"+id, id)
			if err != nil {
				t.Fatal(err)
			}
		}
		if name == "direct_agent" || name == "direct_human" || name == "revoked_agent" || name == "multiple" || name == "trashing" {
			target := "actor_agent_a"
			if name == "direct_human" {
				target = "actor_human_a"
			}
			_, err = pool.Exec(ctx, `INSERT INTO document_direct_collaborators(id,tenant_id,document_id,target_actor_id,role,status,grantor_actor_id,version,revoked_at)
 VALUES($1,'tenant_document_a',$2,$3,'manager',$4,'actor_scale_owner',1,CASE WHEN $4='revoked' THEN clock_timestamp() ELSE NULL END)`, "collaborator_"+id, id, target, map[bool]string{true: "revoked", false: "active"}[name == "revoked_agent"])
			if err != nil {
				t.Fatal(err)
			}
		}
		bindingKind, contextID := "", ""
		switch name {
		case "room", "multiple":
			bindingKind, contextID = "room", "room_document_a"
		case "task_assigned":
			bindingKind, contextID = "task", "work_item_document_a"
		case "task_created":
			bindingKind, contextID = "task", "item_scale_creator"
		case "task_granted":
			bindingKind, contextID = "task", "item_scale_grant"
		case "wiki_source", "wiki_page":
			bindingKind, contextID = name, "wiki_document_a"
		}
		if bindingKind != "" {
			column := map[string]string{"room": "room_id", "task": "work_item_id", "wiki_source": "wiki_id", "wiki_page": "wiki_id"}[bindingKind]
			_, err = pool.Exec(ctx, fmt.Sprintf(`INSERT INTO document_context_bindings(id,tenant_id,document_id,binding_kind,%s,role,status) VALUES($1,'tenant_document_a',$2,$3,$4,'manager','active')`, column), "binding_"+id, id, bindingKind, contextID)
			if err != nil {
				t.Fatal(err)
			}
		}
	}
	service := document.NewWithObjectStore(pool, objects)
	if err := service.Trash(ctx, document.TrashDocumentInput{AccountID: "account_scale_owner", DocumentID: "scale_trashing"}); err != nil {
		t.Fatal(err)
	}
	compare := func(t *testing.T) {
		t.Helper()
		for _, limit := range []int{1, 3, 100} {
			after := ""
			for page := 0; page < 40; page++ {
				rows, err := pool.Query(ctx, agentFileListResolverOracle, "tenant_document_a", "agent_document_a", after, limit)
				if err != nil {
					t.Fatal(err)
				}
				expected := []document.AgentFileEntry{}
				for rows.Next() {
					var e document.AgentFileEntry
					var read, write bool
					if err := rows.Scan(&e.DocumentID, &e.Name, &e.VersionID, &e.VersionNumber, &e.Role, &read, &write, &e.ReadOnly, &e.SharedWithMe); err != nil {
						t.Fatal(err)
					}
					e.Editable = write
					if !read {
						t.Fatalf("the Agent cannot read %s, which its Human reads", e.DocumentID)
					}
					expected = append(expected, e)
				}
				if err := rows.Err(); err != nil {
					t.Fatal(err)
				}
				rows.Close()
				actual, err := service.ListAgentFiles(ctx, "tenant_document_a", "agent_document_a", after, limit, false)
				if err != nil {
					t.Fatal(err)
				}
				if !reflect.DeepEqual(actual, expected) {
					t.Fatalf("limit=%d after=%q\nactual=%+v\nexpected=%+v", limit, after, actual, expected)
				}
				if len(actual) == 0 {
					break
				}
				after = actual[len(actual)-1].DocumentID
			}
		}
	}
	compare(t)
	for _, mutation := range []string{
		`UPDATE work_items SET archived_at=clock_timestamp() WHERE id IN ('work_item_document_a','item_scale_creator','item_scale_grant')`,
		`UPDATE rooms SET deletion_started_at=clock_timestamp(),deletion_started_by_actor_id='actor_human_a' WHERE id='room_document_a'`,
		`UPDATE document_wiki_refreshes SET status='failed',outcome='failed' WHERE id='refresh_scale'`,
		`UPDATE personal_wikis SET deleted_at=clock_timestamp() WHERE id='wiki_document_a'`,
		`UPDATE agent_registrations SET user_artifact_owner_actor_id=NULL WHERE actor_id='actor_agent_a'`,
		`UPDATE agent_registrations SET status='revoked' WHERE actor_id='actor_agent_a'`,
	} {
		if _, err := pool.Exec(ctx, mutation); err != nil {
			t.Fatal(err)
		}
		compare(t)
	}
}

const agentFileListResolverOracle = `WITH registration AS MATERIALIZED (
    SELECT tenant_id,actor_id,user_artifact_owner_actor_id
    FROM agent_registrations
    WHERE tenant_id=$1 AND agent_management_id=$2 AND status='active'
  ), human_principal AS MATERIALIZED (
    SELECT registration.tenant_id,registration.actor_id AS agent_actor_id,
           human.id AS human_actor_id,human.account_id
    FROM registration
    JOIN actors human ON human.id=registration.user_artifact_owner_actor_id
      AND human.tenant_id=registration.tenant_id AND human.kind='human'
  ), candidates AS (
    SELECT document.id
    FROM documents document
    JOIN registration ON registration.tenant_id=document.tenant_id
    JOIN LATERAL resolve_agent_document_access_v2($2,document.id) access
      ON access.tenant_id=document.tenant_id AND access.can_read
    WHERE document.status='active'
    UNION
    SELECT placement.document_id
    FROM document_placements placement
    JOIN human_principal ON human_principal.tenant_id=placement.tenant_id
      AND human_principal.human_actor_id=placement.owner_human_actor_id
    JOIN documents document ON document.id=placement.document_id
      AND document.tenant_id=placement.tenant_id AND document.status='active'
    WHERE placement.scope_kind='personal' AND placement.node_kind='document'
      AND placement.deleted_at IS NULL
    UNION
    SELECT document.id
    FROM documents document
    JOIN human_principal ON human_principal.tenant_id=document.tenant_id
    JOIN LATERAL resolve_human_document_access_v2(human_principal.account_id,document.id) access
      ON access.can_read
    WHERE document.status='active' AND document.owner_actor_id<>human_principal.human_actor_id
      AND NOT EXISTS(SELECT 1 FROM document_placements placement
        WHERE placement.tenant_id=document.tenant_id AND placement.document_id=document.id
          AND placement.scope_kind='personal'
          AND placement.owner_human_actor_id=human_principal.human_actor_id
          AND placement.node_kind='document' AND placement.deleted_at IS NULL)
  )
  SELECT document.id,COALESCE(version.filename,document.title),COALESCE(version.id,''),
         COALESCE(version.version_number,0),COALESCE(agent_access.content_role,''),
         COALESCE(agent_access.can_read,false),COALESCE(agent_access.can_write,false),
         document.format='blocknote'
           OR EXISTS(SELECT 1 FROM document_bodies WHERE document_id=document.id)
           OR document.native_import_status IS NOT NULL,
         EXISTS(SELECT 1 FROM document_direct_collaborators collaborator
           WHERE collaborator.document_id=document.id AND collaborator.tenant_id=document.tenant_id
             AND collaborator.target_actor_id=registration.actor_id AND collaborator.status='active')
  FROM candidates
  JOIN documents document ON document.id=candidates.id AND document.tenant_id=$1
  JOIN registration ON registration.tenant_id=document.tenant_id
  LEFT JOIN LATERAL resolve_agent_document_access_v2($2,document.id) agent_access
    ON agent_access.tenant_id=document.tenant_id
  LEFT JOIN document_versions version ON version.id=document.current_version_id
  WHERE document.id>$3 AND document.status='active'
  ORDER BY document.id LIMIT $4`
