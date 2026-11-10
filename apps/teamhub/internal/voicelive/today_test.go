package voicelive

import (
	"strings"
	"testing"
	"time"
)

func TestAsksAboutToday(t *testing.T) {
	for _, test := range []struct {
		from, to string
		want     bool
	}{
		{"", "", false},
		{"2026-10-18", "2026-10-18", true},
		{"2026-10-12", "2026-10-18", true},
		{"2026-10-12", "2026-10-17", false},
		{"2026-09-01", "", true},
		{"", "2026-10-17", false},
	} {
		if got := AsksAboutToday(test.from, test.to, "2026-10-18"); got != test.want {
			t.Fatalf("%s..%s = %v", test.from, test.to, got)
		}
	}
}

func TestTruncateSaysWhetherItCut(t *testing.T) {
	if text, cut := Truncate("  あいうえお  ", 10); text != "あいうえお" || cut {
		t.Fatalf("short=%q %v", text, cut)
	}
	if text, cut := Truncate("あいうえお", 3); text != "あいう" || !cut {
		t.Fatalf("long=%q %v", text, cut)
	}
}

func TestTodayDigestListsMessagesOldestFirst(t *testing.T) {
	shanghai := time.FixedZone("CST", 8*3600)
	at := time.Date(2026, 10, 18, 8, 5, 0, 0, time.UTC)
	digest := TodayDigest("2026-10-18", " swim \n catch a flight ", []TodayMessage{ // newest first
		{Room: "Sample group", Author: "Mia Chen", Text: "Ball at 4 pm", At: at.Add(time.Hour)},
		{Room: "Weekly sync", Author: "Creative Content Helper", Text: strings.Repeat("x", 300), At: at},
	}, shanghai)
	if digest["pocket_note"] != "swim \n catch a flight" {
		t.Fatalf("note=%q", digest["pocket_note"])
	}
	lines, _ := digest["messages"].([]map[string]string)
	if len(lines) != 2 || lines[0]["time"] != "16:05" || lines[0]["room"] != "Weekly sync" || lines[1]["text"] != "Ball at 4 pm" {
		t.Fatalf("messages=%v", lines)
	}
	if len([]rune(lines[0]["text"])) > 160 {
		t.Fatal("a long message was not shortened")
	}
	if empty := TodayDigest("2026-10-18", "", nil, shanghai); empty["pocket_note"] != nil {
		t.Fatalf("empty note=%v", empty)
	}
}
