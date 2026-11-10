package integration_test

import (
	"net/http"
	"testing"
)

func TestPocketNotesFollowTheHumanAcrossSessionsAndClearToNoPage(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRoomMembershipEnv(t)
	alice := env.login("alice", alicePassword)
	otherDevice := env.login("alice", alicePassword)
	path := "/v0/tenants/" + acmeTenant + "/me/pocket-notes"
	type note struct {
		Date string `json:"date"`
		Text string `json:"text"`
	}
	type page struct {
		Today string `json:"today"`
		Items []note `json:"items"`
	}
	list := func(client *http.Client) page {
		t.Helper()
		status, _, body := env.request(client, http.MethodGet, path, nil, "")
		if status != http.StatusOK {
			t.Fatalf("list Pocket Notes status=%d body=%s", status, body)
		}
		var result page
		decode(t, body, &result)
		return result
	}

	status, _, body := env.request(alice, http.MethodPut, path+"/today", map[string]any{"text": "buy milk"}, "")
	if status != http.StatusOK {
		t.Fatalf("write Pocket Note status=%d body=%s", status, body)
	}
	var written note
	decode(t, body, &written)
	alicePage := list(alice)
	if written.Date != alicePage.Today || len(alicePage.Items) != 1 || alicePage.Items[0] != written {
		t.Fatalf("written=%+v listed=%+v", written, alicePage)
	}
	if otherPage := list(otherDevice); len(otherPage.Items) != 1 || otherPage.Items[0] != written {
		t.Fatalf("another session of the Human listed %+v", otherPage.Items)
	}

	if status, _, body = env.request(alice, http.MethodPut, path+"/today", map[string]any{"text": ""}, ""); status != http.StatusOK {
		t.Fatalf("clear Pocket Note status=%d body=%s", status, body)
	}
	if cleared := list(alice); len(cleared.Items) != 0 {
		t.Fatalf("cleared page still listed: %+v", cleared.Items)
	}
	// Both changes wait in one Tracking Item refresh a while later.
	var refreshes int
	var later bool
	if err := env.pool.QueryRow(t.Context(), `
		SELECT count(*), coalesce(bool_and(scheduled_at > now() + interval '4 minutes'), false)
		FROM river_job
		WHERE kind='voice.pocket_note_tracking' AND state='scheduled'
		  AND args->>'tenant_id'=$1 AND args->>'date'=$2
	`, acmeTenant, written.Date).Scan(&refreshes, &later); err != nil {
		t.Fatal(err)
	}
	if refreshes != 1 || !later {
		t.Fatalf("Pocket Note tracking refreshes=%d scheduled later=%v", refreshes, later)
	}
}

func TestPocketNotesDeletePastDaysOnly(t *testing.T) {
	allowParallelIntegrationTest(t)
	env := newRoomMembershipEnv(t)
	alice := env.login("alice", alicePassword)
	path := "/v0/tenants/" + acmeTenant + "/me/pocket-notes"
	if _, err := env.pool.Exec(t.Context(), `
		INSERT INTO pocket_notes(tenant_id,owner_actor_id,note_date,body)
		SELECT tenant_id,id,'2026-01-01','old note' FROM actors
		WHERE tenant_id=$1 AND account_id='account_alice' AND kind='human'
	`, acmeTenant); err != nil {
		t.Fatal(err)
	}
	status, _, body := env.request(alice, http.MethodPut, path+"/today", map[string]any{"text": "today's note"}, "")
	if status != http.StatusOK {
		t.Fatalf("write Pocket Note status=%d body=%s", status, body)
	}
	var today struct {
		Date string `json:"date"`
	}
	decode(t, body, &today)
	listed := func() []string {
		t.Helper()
		status, _, body := env.request(alice, http.MethodGet, path, nil, "")
		if status != http.StatusOK {
			t.Fatalf("list Pocket Notes status=%d body=%s", status, body)
		}
		var page struct {
			Items []struct {
				Date string `json:"date"`
			} `json:"items"`
		}
		decode(t, body, &page)
		dates := make([]string, 0, len(page.Items))
		for _, item := range page.Items {
			dates = append(dates, item.Date)
		}
		return dates
	}

	// Today's page stays editable and cannot be deleted.
	if status, _, body := env.request(alice, http.MethodDelete, path+"/"+today.Date, nil, ""); status != http.StatusBadRequest {
		t.Fatalf("delete today status=%d body=%s", status, body)
	}
	for range 2 {
		if status, _, body := env.request(alice, http.MethodDelete, path+"/2026-01-01", nil, ""); status != http.StatusNoContent {
			t.Fatalf("delete past day status=%d body=%s", status, body)
		}
	}
	if dates := listed(); len(dates) != 1 || dates[0] != today.Date {
		t.Fatalf("listed after delete=%v", dates)
	}
}
