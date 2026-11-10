package externalsource

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

type AgentToolConnection struct {
	// AgentActorID is the Agent whose grant authorized this connection.
	AgentActorID         string
	AccountID            string
	UserID               string
	ID                   string
	AppKey               string
	DisplayName          string
	IdentityLabel        string
	ToolkitSlug          string
	UpstreamConnectionID string
	Revision             int64
}

func (s *Service) ListGrantedAgentToolConnectionsInTx(
	ctx context.Context,
	tx pgx.Tx,
	agentActorID, tenantID, connectionID, appKey string,
) ([]AgentToolConnection, error) {
	if tx == nil || agentActorID == "" || tenantID == "" {
		return nil, ErrInvalid
	}
	rows, err := tx.Query(ctx, `
		SELECT connection.account_id,connection.id,connection.provider,
		       coalesce(connection.identity_label,''),coalesce(connection.toolkit_slug,''),
		       connection.upstream_connection_id,connection.revision
		FROM external_connection_agent_grants delegation
		JOIN external_connections connection ON connection.id=delegation.connection_id
		JOIN agent_registrations registration
		  ON registration.actor_id=delegation.agent_actor_id
		 AND registration.tenant_id=delegation.tenant_id
		JOIN actors represented
		  ON represented.id=delegation.represented_human_actor_id
		 AND represented.tenant_id=delegation.tenant_id
		 AND represented.kind='human'
		 AND represented.account_id=connection.account_id
		WHERE delegation.agent_actor_id=$1 AND delegation.tenant_id=$2
		  AND delegation.status='active'
		  AND registration.status='active'
		  AND registration.agent_type IN ('anotherme','general')
		  AND connection.status='active'
		  AND ($3='' OR connection.id=$3)
		  AND ($4='' OR connection.provider=$4)
		ORDER BY CASE connection.provider WHEN 'gmail' THEN 0 WHEN 'slack' THEN 1 ELSE 2 END,
		         connection.created_at,connection.id`,
		agentActorID, tenantID, connectionID, appKey,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	connections := make([]AgentToolConnection, 0)
	for rows.Next() {
		var connection AgentToolConnection
		if err := rows.Scan(
			&connection.AccountID, &connection.ID, &connection.AppKey, &connection.IdentityLabel,
			&connection.ToolkitSlug, &connection.UpstreamConnectionID, &connection.Revision,
		); err != nil {
			return nil, err
		}
		app, ok := s.agentToolsApp(connection.AppKey)
		if !ok || connection.ToolkitSlug != toolkitForApp(connection.AppKey) {
			continue
		}
		connection.AgentActorID = agentActorID
		connection.UserID = s.managed.client.UserIDForAccount(connection.AccountID)
		connection.DisplayName = app.DisplayName
		connections = append(connections, connection)
	}
	return connections, rows.Err()
}

func (s *Service) LockGrantedAgentToolConnectionInTx(
	ctx context.Context,
	tx pgx.Tx,
	agentActorID, tenantID, connectionID string,
) (AgentToolConnection, error) {
	if tx == nil || agentActorID == "" || tenantID == "" || connectionID == "" {
		return AgentToolConnection{}, ErrInvalid
	}
	var eligible bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS(
			SELECT 1 FROM external_connection_agent_grants
			WHERE connection_id=$1 AND agent_actor_id=$2 AND tenant_id=$3 AND status='active'
		)`, connectionID, agentActorID, tenantID).Scan(&eligible); err != nil {
		return AgentToolConnection{}, err
	}
	if !eligible {
		return AgentToolConnection{}, ErrNotFound
	}
	var connection AgentToolConnection
	var status string
	if err := tx.QueryRow(ctx, `
		SELECT account_id,id,provider,coalesce(identity_label,''),coalesce(toolkit_slug,''),
		       upstream_connection_id,revision,status
		FROM external_connections
		WHERE id=$1
		FOR SHARE`, connectionID).Scan(
		&connection.AccountID, &connection.ID, &connection.AppKey, &connection.IdentityLabel,
		&connection.ToolkitSlug, &connection.UpstreamConnectionID, &connection.Revision, &status,
	); errors.Is(err, pgx.ErrNoRows) {
		return AgentToolConnection{}, ErrNotFound
	} else if err != nil {
		return AgentToolConnection{}, err
	}
	var current bool
	if err := tx.QueryRow(ctx, `
		SELECT true
		FROM external_connection_agent_grants delegation
		JOIN agent_registrations registration
		  ON registration.actor_id=delegation.agent_actor_id
		 AND registration.tenant_id=delegation.tenant_id
		JOIN actors represented
		  ON represented.id=delegation.represented_human_actor_id
		 AND represented.tenant_id=delegation.tenant_id
		 AND represented.kind='human'
		WHERE delegation.connection_id=$1
		  AND delegation.agent_actor_id=$2 AND delegation.tenant_id=$3
		  AND delegation.status='active'
		  AND registration.status='active'
		  AND registration.agent_type IN ('anotherme','general')
		  AND represented.account_id=$4
		FOR SHARE OF delegation,registration,represented`,
		connectionID, agentActorID, tenantID, connection.AccountID,
	).Scan(&current); errors.Is(err, pgx.ErrNoRows) {
		return AgentToolConnection{}, ErrNotFound
	} else if err != nil {
		return AgentToolConnection{}, err
	}
	app, ok := s.agentToolsApp(connection.AppKey)
	if !current || status != "active" || !ok || connection.ToolkitSlug != toolkitForApp(connection.AppKey) {
		return AgentToolConnection{}, ErrNotActive
	}
	connection.AgentActorID = agentActorID
	connection.UserID = s.managed.client.UserIDForAccount(connection.AccountID)
	connection.DisplayName = app.DisplayName
	return connection, nil
}
