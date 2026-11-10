"""Manual PostgreSQL fixture check; run through with-test-database.sh.

Requires Python 3, psql and Docker. It is not part of the default CI suite.
The fixture checks this reporting query, not the complete migrated schema.
"""

import hashlib
import json
import os
from pathlib import Path
import subprocess


SCRIPT_DIR = Path(__file__).resolve().parent
DATABASE_URL = os.environ["TEST_DATABASE_URL"]
if not os.environ.get("TEAMHUB_TEST_RUN_TOKEN") or "/teamhub_test_control?" not in DATABASE_URL:
    raise SystemExit("Run this fixture through scripts/with-test-database.sh")


def query(sql):
    result = subprocess.run(
        ["psql", DATABASE_URL, "-X", "-qAt", "-v", "ON_ERROR_STOP=1"],
        input=sql, text=True, capture_output=True, check=False,
    )
    if result.returncode:
        raise AssertionError(result.stderr)
    return result.stdout


def profile(hours=1):
    result = subprocess.run(
        ["psql", DATABASE_URL, "-X", "-qAt", "-v", "ON_ERROR_STOP=1",
         "-v", f"profile_hours={hours}", "-v", "profile_until=2020-01-01T01:00:00Z",
         "-f", str(SCRIPT_DIR / "agent-wake-topology-profile.sql")],
        text=True, capture_output=True, check=False,
    )
    if result.returncode:
        raise AssertionError(result.stderr)
    return json.loads(result.stdout)


def load_function(migration, name):
    source = (SCRIPT_DIR.parent / "migrations" / migration).read_text()
    start = source.index(f"CREATE FUNCTION {name}(")
    end = source.index("-- +goose StatementEnd", start)
    query(source[start:end])


def tenant_profile(data, tenant):
    digest = hashlib.md5(tenant.encode()).hexdigest()[:12]
    return next(item for item in data["tenants"] if item["tenant"] == digest)


def check_dense_reference(data):
    """Use PostgreSQL's dense percentile_disc as an independent reference."""
    expected = json.loads(query(f"""
        WITH counts AS (
            SELECT tenant_id,date_trunc('minute',occurred_at) AS minute,count(*) AS value
            FROM room_events WHERE room_seq>0 AND occurred_at>='{data['since']}' AND occurred_at<'{data['until']}'
            GROUP BY 1,2
        ), samples AS (
            SELECT t.id AS tenant_id,m.minute,coalesce(c.value,0) AS value
            FROM (SELECT DISTINCT tenant_id AS id FROM actors WHERE kind='human') t CROSS JOIN generate_series('{data['since']}'::timestamptz,'{data['until']}'::timestamptz-interval '1 minute',interval '1 minute') m(minute)
            LEFT JOIN counts c ON c.tenant_id=t.id AND c.minute=m.minute
            UNION ALL
            SELECT NULL,m.minute,coalesce(sum(c.value),0)
            FROM generate_series('{data['since']}'::timestamptz,'{data['until']}'::timestamptz-interval '1 minute',interval '1 minute') m(minute)
            LEFT JOIN counts c ON c.minute=m.minute GROUP BY m.minute
        ), distributions AS (
            SELECT coalesce(left(md5(tenant_id),12),'global') AS tenant,
                jsonb_build_object('total',sum(value),'mean_per_minute',round(avg(value),4),'peak',max(value),
                    'p50',percentile_disc(.5) WITHIN GROUP(ORDER BY value),
                    'p95',percentile_disc(.95) WITHIN GROUP(ORDER BY value),
                    'p99',percentile_disc(.99) WITHIN GROUP(ORDER BY value),
                    'nonzero_minutes',count(*) FILTER(WHERE value>0)) AS distribution
            FROM samples GROUP BY tenant_id
        ) SELECT jsonb_object_agg(tenant,distribution) FROM distributions;
    """))
    actual = {item["tenant"]: item["metrics"]["room_events"] for item in data["tenants"]}
    actual["global"] = data["global"]["metrics"]["room_events"]
    assert actual == expected, (actual, expected)


query((SCRIPT_DIR / "fixtures" / "agent-wake-topology-profile.sql").read_text())
old = profile()
assert old["receiver_supported"] is False
assert old["global"]["metrics"]["events_with_current_receiver"] is None
assert old["global"]["event_ratios"]["current_receiver"] is None
assert old["global"]["metrics"]["room_events"]["total"] == 11
assert old["global"]["metrics"]["threads_created"]["total"] == 3
assert old["global"]["metrics"]["rooms_created"]["total"] == 7
assert old["global"]["metrics"]["members_removed"]["total"] == 2
assert old["global"]["metrics"]["agent_members_removed"]["total"] == 1
assert old["global"]["metrics"]["task_generations_created"]["total"] == 5
check_dense_reference(old)

load_function("00102_room_threads.sql", "collaboration_membership_room_id")
load_function("00311_room_participation.sql", "room_actor_participating")
for function in ["agent_inbox_resource_room", "actor_can_read_inbox", "agent_context_can_receive_inbox"]:
    load_function("00381_direct_inbox_foundation.sql", function)

# Compare against exhaustive current authority before instrumenting it.
expected = int(query("""
    SELECT count(*) FROM room_events e
    WHERE e.room_seq>0 AND e.occurred_at>='2020-01-01T00:00Z' AND e.occurred_at<'2020-01-01T01:00Z'
      AND EXISTS(SELECT 1 FROM agent_execution_contexts c JOIN agent_registrations reg
        ON reg.tenant_id=c.tenant_id AND reg.actor_id=c.agent_actor_id AND reg.agent_management_id=c.agent_management_id
        CROSS JOIN LATERAL (
            SELECT 'room:'||e.room_id AS inbox_id
            WHERE NOT EXISTS(SELECT 1 FROM rooms t WHERE t.tenant_id=e.tenant_id AND t.id=e.room_id AND t.parent_room_id IS NOT NULL)
              AND NOT EXISTS(SELECT 1 FROM work_item_room_links l JOIN work_items w
                ON w.id=l.work_item_id AND w.tenant_id=l.tenant_id AND w.kind='task'
                WHERE l.tenant_id=e.tenant_id AND l.room_id=e.room_id AND l.link_type='work')
            UNION ALL
            SELECT 'thread:'||e.room_id FROM rooms t
            WHERE t.tenant_id=e.tenant_id AND t.id=e.room_id AND t.parent_room_id IS NOT NULL
            UNION ALL
            SELECT 'task:'||l.work_item_id FROM work_item_room_links l JOIN work_items w
                ON w.id=l.work_item_id AND w.tenant_id=l.tenant_id AND w.kind='task'
            WHERE l.tenant_id=e.tenant_id AND l.room_id=e.room_id AND l.link_type='work'
        ) inbox
        WHERE c.tenant_id=e.tenant_id AND c.terminal_reason IS NULL AND reg.status='active'
          AND (c.room_id IS NULL OR EXISTS(SELECT 1 FROM active_room_members m WHERE m.tenant_id=c.tenant_id AND m.room_id=c.room_id AND m.actor_id=c.agent_actor_id AND m.membership_epoch_id=c.membership_epoch_id))
          AND agent_context_can_receive_inbox(c.context_key,inbox.inbox_id));
"""))
assert expected == 8, expected
# Confirm the overlap fixture exercises both authorization branches. The outer
# EXISTS above must count each event once, even when both Inboxes have receivers.
assert json.loads(query("""
    SELECT jsonb_build_array(
        EXISTS(SELECT 1 FROM agent_execution_contexts c WHERE agent_context_can_receive_inbox(c.context_key,'thread:denied_thread')),
        agent_context_can_receive_inbox('global_coord','task:thread_task'),
        agent_context_can_receive_inbox('room_a','thread:listed_thread'),
        agent_context_can_receive_inbox('global_coord','task:listed_thread_task'),
        agent_context_can_receive_inbox('room_a','room:r'),
        agent_context_can_receive_inbox('room_a','task:room_issue'));
""")) == [False, True, True, True, True, False]
query("""
    ALTER FUNCTION agent_context_can_receive_inbox(text,text) RENAME TO fixture_can_receive_inbox;
    CREATE FUNCTION agent_context_can_receive_inbox(p_context text,p_inbox text) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
    BEGIN
        IF p_context LIKE 'unrelated_%' THEN RAISE EXCEPTION 'unrelated Context reached receiver predicate'; END IF;
        RETURN fixture_can_receive_inbox(p_context,p_inbox);
    END $$;
""")
current = profile()
assert current["global"]["metrics"]["events_with_current_receiver"]["total"] == expected
assert tenant_profile(current, "tenant_45")["event_ratios"]["current_receiver"] is None
assert profile(168)["global"]["metrics"]["events_with_current_receiver"]["total"] == expected+1

# Each no-coordinator Task authority path must work without another recipient
# hiding a missed candidate. Initial generation participants are not current.
query("DELETE FROM room_members WHERE room_id='unowned_task_room'; DELETE FROM work_item_assignments;")
assert profile()["global"]["metrics"]["events_with_current_receiver"]["total"] == expected
query("DELETE FROM task_execution_participants; INSERT INTO work_item_assignments VALUES('unowned_task','tenant_1','assigned');")
assert profile()["global"]["metrics"]["events_with_current_receiver"]["total"] == expected
query("DELETE FROM work_item_assignments; UPDATE task_execution_generations SET coordinator_actor_id='coord' WHERE task_id='unowned_task' AND generation=2;")
assert profile()["global"]["metrics"]["events_with_current_receiver"]["total"] == expected
query("UPDATE task_execution_generations SET coordinator_actor_id=NULL WHERE task_id='unowned_task' AND generation=2; INSERT INTO task_execution_participants VALUES('unowned_task','tenant_1',1,'p','mgmt_p');")
assert profile()["global"]["metrics"]["events_with_current_receiver"]["total"] == expected-1
query("INSERT INTO task_execution_participants VALUES('unowned_task','tenant_1',2,'p','mgmt_p'); UPDATE agent_execution_contexts SET terminal_reason='terminated' WHERE context_key='global_a';")
assert profile()["global"]["metrics"]["events_with_current_receiver"]["total"] == expected

# Exercise percentiles on both sides of zero-rank boundaries and overlapping tenants.
query("DROP FUNCTION agent_context_can_receive_inbox(text,text); TRUNCATE room_events;")
for nonzero_minutes in [0, 2, 3, 6, 30, 31, 60]:
    query(f"""
        TRUNCATE room_events;
        INSERT INTO room_events
        SELECT 'tenant_1','r',n,'message.created','2020-01-01T00:00Z'::timestamptz+make_interval(mins=>m),NULL
        FROM generate_series(0,{nonzero_minutes}-1) m CROSS JOIN LATERAL generate_series(1,1+(m*7)%9) n;
        INSERT INTO room_events SELECT 'tenant_2','r2',1,'message.created','2020-01-01T00:00Z'::timestamptz+make_interval(mins=>m),NULL
        FROM generate_series(0,{nonzero_minutes}-1) m;
    """)
    check_dense_reference(profile())

week = profile(168)
assert week["minutes"] == 10080 and len(week["tenants"]) == 45
assert week["global"]["metrics"]["room_events"]["total"] == profile()["global"]["metrics"]["room_events"]["total"]
query("TRUNCATE room_events,room_members,task_execution_generations,rooms;")
zero = profile()
assert zero["global"]["event_ratios"]["current_agent_member"] is None
assert zero["global_nonzero_minutes"] == []
query("TRUNCATE actors;")
assert profile()["global"]["metrics"]["room_events"]["total"] == 0
print("PASS: dense percentile reference, zero boundaries, 168 hours, old schema, authoritative Room/Thread/Task receiver recall, overlapping Thread/Task event deduplication, non-Task Work Room, unrelated Context exclusion and topology history")
