package composio

import (
	"context"
	"net/http"
)

// FileUploadRequest follows the Files API used by Composio's official SDK.
// The API key remains in TeamHub; only the single-file upload URL leaves it.
type FileUploadRequest struct {
	Filename    string `json:"filename"`
	Mimetype    string `json:"mimetype"`
	MD5         string `json:"md5"`
	ToolSlug    string `json:"tool_slug"`
	ToolkitSlug string `json:"toolkit_slug"`
}
type FileUploadTarget struct {
	Key string `json:"key"`
	URL string `json:"new_presigned_url"`
}

func (c *Client) RequestFileUpload(ctx context.Context, input FileUploadRequest) (FileUploadTarget, error) {
	var target FileUploadTarget
	err := c.requestJSONOnce(ctx, http.MethodPost, "/api/v3.1/files/upload/request", input, &target, "prepare file upload")
	return target, err
}
