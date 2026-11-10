package voicelive

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestEmailCanvasIsTheGmailCanvasShape(t *testing.T) {
	canvas, problem := EmailCanvas(EmailCanvasArguments{
		To:      "amy@example.com； bob@example.org、",
		Subject: " Next Wed  LA airport pickup\n",
		Body:    "\nHi Amy,\n\nCan you pick me up at LAX at 9 am next Wednesday?\n",
	})
	if problem != "" {
		t.Fatalf("problem=%s", problem)
	}
	want := "```\ncanvas: gmail\nto: amy@example.com, bob@example.org\ncc:\nsubject: Next Wed LA airport pickup\nstatus: editing\nlink:\nexternal_id:\n```\n\nHi Amy,\n\nCan you pick me up at LAX at 9 am next Wednesday?\n"
	if canvas.Title != "Next Wed LA airport pickup" || canvas.Markdown != want {
		t.Fatalf("canvas=%+v", canvas)
	}
}

func TestEmailCanvasRefusesWhatTheModelMustFix(t *testing.T) {
	for _, check := range []struct {
		args    EmailCanvasArguments
		problem string
	}{
		// A spoken name is not an address; the model asks for it.
		{EmailCanvasArguments{To: "Amy", Subject: "s", Body: "b"}, "invalid_recipients"},
		{EmailCanvasArguments{Cc: "amy@", Subject: "s", Body: "b"}, "invalid_recipients"},
		{EmailCanvasArguments{Subject: " ", Body: "b"}, "invalid_email"},
		{EmailCanvasArguments{Subject: "s", Body: strings.Repeat("x", MaxEmailBodyRunes+1)}, "invalid_email"},
	} {
		if _, problem := EmailCanvas(check.args); problem != check.problem {
			t.Fatalf("%+v: problem=%q, want %q", check.args, problem, check.problem)
		}
	}
	// The title comes from the subject, bounded.
	canvas, _ := EmailCanvas(EmailCanvasArguments{Subject: "Q3/Q4 " + strings.Repeat("plan", 60), Body: "b"})
	if utf8.RuneCountInString(canvas.Title) > canvasTitleRunes || !strings.HasPrefix(canvas.Title, "Q3/Q4 ") {
		t.Fatalf("title=%q", canvas.Title)
	}
}

func TestEditedEmailCanvasKeepsWhatTheChangeLeavesOut(t *testing.T) {
	fields := map[string]string{
		"to": "amy@example.com", "cc": "", "subject": "Pickup", "status": "draft",
		"link": "https://mail.google.com/mail/#drafts", "external_id": "r-1", "owner": "me",
	}
	body := "Hi Amy,\n\nCan you pick me up?\n"
	subject, cc := "Next Wed LA airport pickup", "bob@example.org"
	markdown, header, problem := EditedEmailCanvas(fields, body, EditEmailCanvasArguments{Subject: &subject, Cc: &cc})
	wantHeader := "```\ncanvas: gmail\nto: amy@example.com\ncc: bob@example.org\nsubject: Next Wed LA airport pickup\nstatus: draft\nlink: https://mail.google.com/mail/#drafts\nexternal_id: r-1\nowner: me\n```\n"
	if problem != "" || markdown != wantHeader+"\nHi Amy,\n\nCan you pick me up?\n" || header != wantHeader {
		t.Fatalf("problem=%q markdown=%q header=%q", problem, markdown, header)
	}
	// A new body replaces the whole body; the header stays.
	newBody := "Hi Amy,\n\n9 am next Wednesday, barbecue is on me!"
	markdown, _, _ = EditedEmailCanvas(fields, body, EditEmailCanvasArguments{Body: &newBody})
	if !strings.HasSuffix(markdown, "```\n\nHi Amy,\n\n9 am next Wednesday, barbecue is on me!\n") || !strings.Contains(markdown, "subject: Pickup\n") {
		t.Fatalf("markdown=%q", markdown)
	}
	// A spoken name is not an address, and an empty body is no email.
	name, empty := "Bob", " "
	if _, _, problem := EditedEmailCanvas(fields, body, EditEmailCanvasArguments{To: &name}); problem != "invalid_recipients" {
		t.Fatalf("name as recipient: %q", problem)
	}
	if _, _, problem := EditedEmailCanvas(fields, body, EditEmailCanvasArguments{Body: &empty}); problem != "invalid_email" {
		t.Fatalf("empty body: %q", problem)
	}
}
