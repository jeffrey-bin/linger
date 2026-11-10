package voicelive

import (
	"path"
	"strings"
)

// ToolTaskFiles names the existing-task output reader.
const ToolTaskFiles = "task_files"

// ToolPublishTaskResult names durable report publication.
const ToolPublishTaskResult = "publish_task_result"

// TaskFilesArguments selects a relative path inside an authorized task output root.
type TaskFilesArguments struct {
	TaskID string `json:"task_id"`
	Action string `json:"action"`
	Path   string `json:"path"`
}

// PublishTaskResultArguments selects a report and verified files for publication.
type PublishTaskResultArguments struct {
	TaskID   string   `json:"task_id"`
	ReportID string   `json:"report_id"`
	Title    string   `json:"title"`
	Text     string   `json:"text"`
	Files    []string `json:"files"`
}

func init() {
	Tools = append(Tools, Tool{Name: ToolTaskFiles, Description: "Read an existing task's actual output directory directly on the user's Local Computer, without starting a Meta model or mounting a Meta workspace. action list lists paths; action read reads at most 3000 characters of a UTF-8 text file. Paths are relative to this task's own output root, such as report.md; the root is the folder the task calls ./playground/<its id>. Never guess a file exists: list first.", Parameters: objectSchema([]string{"task_id", "action"}, map[string]any{"task_id": stringProperty("Task handle such as t1"), "action": map[string]any{"type": "string", "enum": []string{"list", "read"}}, "path": stringProperty("Relative path, empty for the root")})},
		Tool{Name: ToolPublishTaskResult, Description: "Deliver a task report or question as an Agent message with its actual files. Call this before telling the user the result is delivered. Use report_id from list_tasks; publication is durable and happens only once per report. files are up to 5 relative task output paths verified with task_files; use an empty list for a question or a report without files. This never sends as the user. It uses the private coordinator room for tasks from group rooms. A completed task may be read after switching modes. Do not run the original task again.", Parameters: objectSchema([]string{"task_id", "report_id", "title", "text", "files"}, map[string]any{"task_id": stringProperty("Task handle"), "report_id": stringProperty("Exact latest report_id"), "title": stringProperty("Short result title"), "text": stringProperty("Result or question in the user's language"), "files": map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "maxItems": 5}})})
}

// TaskFilePath is a path relative to the task's output root. A task names
// its files from its own workspace, as ./playground/<task id>/report.md, and
// the live model repeats that; the root is the playground's task folder.
func TaskFilePath(raw, workItemID string) string {
	cleaned := path.Clean(strings.TrimSpace(raw))
	for _, prefix := range []string{"playground/" + workItemID, workItemID} {
		if cleaned == prefix {
			return ""
		}
		if rest, ok := strings.CutPrefix(cleaned, prefix+"/"); ok {
			return rest
		}
	}
	if cleaned == "." {
		return ""
	}
	return cleaned
}
