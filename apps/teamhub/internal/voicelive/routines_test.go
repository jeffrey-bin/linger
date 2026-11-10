package voicelive

import (
	"strings"
	"testing"
	"time"
)

func TestRoutineCadenceReadsEachKind(t *testing.T) {
	future := time.Now().Add(48 * time.Hour).In(time.FixedZone("CST", 8*3600))
	once, ok := RoutineCadence(RoutineArguments{Kind: "once", RunAt: future.Format(time.RFC3339), Timezone: "Asia/Shanghai"})
	if !ok || once.Kind != "once" || once.RunAt == nil || !once.RunAt.Equal(future.Truncate(time.Second)) {
		t.Fatalf("once=%+v ok=%v", once, ok)
	}
	// A local time without an offset is read in the zone the model gave.
	local, ok := RoutineCadence(RoutineArguments{Kind: "once", RunAt: future.Format("2006-01-02 15:04"), Timezone: "Asia/Shanghai"})
	if !ok || local.RunAt.Format("15:04") != future.UTC().Format("15:04") {
		t.Fatalf("local once=%+v ok=%v", local, ok)
	}
	daily, ok := RoutineCadence(RoutineArguments{Kind: "daily", Time: "08:30", Timezone: "Asia/Shanghai"})
	if !ok || *daily.Hour != 8 || *daily.Minute != 30 || RoutineWhen(daily) != "every day at 08:30 (Asia/Shanghai)" {
		t.Fatalf("daily=%+v ok=%v when=%q", daily, ok, RoutineWhen(daily))
	}
	weekly, ok := RoutineCadence(RoutineArguments{Kind: "weekly", Time: "09:00", Timezone: "Asia/Shanghai", Weekdays: []string{"friday", "monday"}})
	if !ok || RoutineWhen(weekly) != "every monday, friday at 09:00 (Asia/Shanghai)" {
		t.Fatalf("weekly=%+v ok=%v when=%q", weekly, ok, RoutineWhen(weekly))
	}
	hourly, ok := RoutineCadence(RoutineArguments{Kind: "every_n_hours", IntervalHours: 3})
	if !ok || RoutineWhen(hourly) != "every 3 hours" {
		t.Fatalf("hourly=%+v ok=%v", hourly, ok)
	}
}

func TestRoutineCadenceRejectsIncompleteSchedules(t *testing.T) {
	for name, args := range map[string]RoutineArguments{
		"no kind":          {},
		"once without at":  {Kind: "once"},
		"once in the past": {Kind: "once", RunAt: time.Now().Add(-time.Hour).Format(time.RFC3339)},
		"local without tz": {Kind: "once", RunAt: "2099-01-01 08:00"},
		"daily no time":    {Kind: "daily", Timezone: "Asia/Shanghai"},
		"daily bad zone":   {Kind: "daily", Time: "08:00", Timezone: "Mars/Base"},
		"weekly no days":   {Kind: "weekly", Time: "08:00", Timezone: "Asia/Shanghai"},
		"hours zero":       {Kind: "every_n_hours"},
		"hours too many":   {Kind: "every_n_hours", IntervalHours: 169},
	} {
		if _, ok := RoutineCadence(args); ok && name != "once in the past" {
			t.Fatalf("%s accepted", name)
		}
	}
}

func TestRoutineSummarySaysWhenAndWhat(t *testing.T) {
	cadence, _ := RoutineCadence(RoutineArguments{Kind: "daily", Time: "20:00", Timezone: "Asia/Shanghai"})
	reminder := RoutineSummary("Call", "Reminder: call Mom", cadence, false)
	work := RoutineSummary("Schedule", "Read today's schedule", cadence, true)
	if !strings.Contains(reminder, "every day at 20:00") || !strings.Contains(reminder, "post this reminder") ||
		!strings.Contains(work, "wake the Agent") || reminder == work {
		t.Fatalf("summaries %q %q", reminder, work)
	}
}
