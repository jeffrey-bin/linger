package integration_test

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"net/http"
	"testing"

	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func TestRoomHistorySharingSnapshotAndRevocation(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newWorkItemAgentEnv(t)
	anonymous := &http.Client{}
	roomID := createPrivateRoom(t, env, alice, "Shared history", "history-room")
	path := "/v0/rooms/" + roomID
	must := func(want int, client *http.Client, method, url string, payload any, key string) []byte {
		t.Helper()
		status, headers, body := env.request(client, method, url, payload, key)
		if status != want {
			t.Fatalf("%s %s status=%d want=%d body=%s", method, url, status, want, body)
		}
		if url == "/v0/shared-room-history/read" && headers.Get("Cache-Control") != "no-store" {
			t.Fatal("public response must not cache")
		}
		return body
	}
	for i := 0; i < 51; i++ {
		env.createMessage(alice, roomID, fmt.Sprintf("Message **%02d**", i), fmt.Sprintf("share-message-%d", i))
	}
	png, err := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=")
	if err != nil {
		t.Fatal(err)
	}
	upload := uploadMessageAttachmentWithMediaType(t, alice, env.server.URL, roomID, "share-image", "pixel.png", "image/png", png)
	must(201, alice, "POST", path+"/messages", map[string]any{"raw_message": "Snapshot image", "segments": []map[string]any{{"type": "text", "content": "Snapshot image"}}, "attachment_upload_ids": []string{upload.ID}}, "share-image-message")
	create := func() httpapi.RoomHistoryShare {
		t.Helper()
		var share httpapi.RoomHistoryShare
		decode(t, must(201, alice, "POST", path+"/history-shares/create", map[string]any{"web_version": "integration-proof"}, ""), &share)
		return share
	}
	first := create()
	if first.Token == nil || first.MessageCount != 52 {
		t.Fatalf("bad snapshot: %+v", first)
	}
	token := *first.Token
	var relinked httpapi.RoomHistoryShare
	decode(t, must(200, alice, "POST", path+"/history-shares/"+first.Id+"/link", nil, ""), &relinked)
	if relinked.Token == nil || *relinked.Token == token || relinked.MessageCount != first.MessageCount {
		t.Fatalf("bad relink response: %+v", relinked)
	}
	must(404, anonymous, "POST", "/v0/shared-room-history/read", map[string]any{"token": token}, "")
	token = *relinked.Token
	read := func(after int64) httpapi.RoomHistorySnapshot {
		t.Helper()
		var value httpapi.RoomHistorySnapshot
		decode(t, must(200, anonymous, "POST", "/v0/shared-room-history/read", map[string]any{"token": token, "after": after}, ""), &value)
		return value
	}
	page := read(0)
	if len(page.Items) != 50 || page.NextAfter != 50 {
		t.Fatalf("bad first page: %d %d", len(page.Items), page.NextAfter)
	}
	last := read(page.NextAfter)
	if len(last.Items) != 2 || last.NextAfter != 0 {
		t.Fatal("bad last page")
	}
	image := last.Items[1].Attachments[0]
	if image.ImageAssetId == nil {
		t.Fatal("image missing")
	}
	assetPayload := map[string]any{"token": token, "asset_id": *image.ImageAssetId}
	if got := must(200, anonymous, "POST", "/v0/shared-room-history/asset", assetPayload, ""); !bytes.Equal(got, png) {
		t.Fatal("snapshot image differs")
	}
	must(404, anonymous, "POST", "/v0/shared-room-history/asset", map[string]any{"token": token, "asset_id": "foreign-asset"}, "")
	must(401, anonymous, "GET", path+"/messages", nil, "")
	// Mutate the source representation to prove the reader never rehydrates it.
	if _, err := env.pool.Exec(t.Context(), `UPDATE messages SET body='Changed after sharing',segments='[{"type":"text","content":"Changed after sharing"}]'::jsonb WHERE id=$1`, page.Items[0].Id); err != nil {
		t.Fatal(err)
	}
	env.createMessage(alice, roomID, "After snapshot", "after-snapshot")
	if read(0).Items[0].Body != page.Items[0].Body || read(50).Share.MessageCount != 52 {
		t.Fatal("source mutation changed snapshot")
	}
	must(200, alice, "PUT", path+"/participation", map[string]any{"status": "left"}, "share-owner-leave")
	read(0)
	must(409, alice, "POST", path+"/history-shares/create", map[string]any{}, "")
	must(200, alice, "PUT", path+"/participation", map[string]any{"status": "joined"}, "share-owner-rejoin")
	list := must(200, alice, "GET", path+"/history-shares", nil, "")
	if bytes.Contains(list, []byte(token)) {
		t.Fatal("list leaked token")
	}
	must(204, alice, "DELETE", path+"/history-shares/"+first.Id, nil, "")
	must(404, anonymous, "POST", "/v0/shared-room-history/read", map[string]any{"token": token}, "")
	must(404, anonymous, "POST", "/v0/shared-room-history/asset", assetPayload, "")
	third := create()
	token = *third.Token
	must(204, alice, "DELETE", path, nil, "delete-shared-room")
	must(404, anonymous, "POST", "/v0/shared-room-history/read", map[string]any{"token": token}, "")
}
