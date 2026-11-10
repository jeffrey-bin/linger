package app

import (
	"bytes"
	"encoding/base64"
	"errors"
	"mime/multipart"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

type documentUpload struct {
	ParentID                                  *string
	Filename, RepresentationFormat, MediaType string
	Content                                   multipart.File
}

// uploadReadTimeout replaces the server's 30-second whole-request read timeout
// for upload routes, so a large file on a slow link is not cut off.
const uploadReadTimeout = 10 * time.Minute

// isMaxBytesError reports whether http.MaxBytesReader rejected an oversized body.
func isMaxBytesError(err error) bool {
	var maxBytesErr *http.MaxBytesError
	return errors.As(err, &maxBytesErr)
}

func extendUploadReadDeadline(c *gin.Context) error {
	err := http.NewResponseController(c.Writer).SetReadDeadline(time.Now().Add(uploadReadTimeout))
	if errors.Is(err, http.ErrNotSupported) {
		return nil
	}
	return err
}

func (a *App) createDocument(c *gin.Context) {
	tenantID := c.Param("tenantId")
	var request httpapi.DocumentCreateRequest
	if decodeJSON(c, &request) != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Document creation input is invalid")
		return
	}
	result, err := a.documents.Create(c.Request.Context(), document.CreateDocumentInput{
		AccountID: currentPrincipal(c).Session.AccountID, TenantID: tenantID,
		ParentID: unifiedDocumentStringIDPointer(request.ParentId), RepresentationFormat: optionalNativeRepresentationFormat(request.RepresentationFormat),
	})
	if a.writeUnifiedDocumentError(c, "create Document", err) {
		return
	}
	c.JSON(http.StatusCreated, documentModel(result.Document))
}

func optionalNativeRepresentationFormat(value *httpapi.DocumentCreateRequestRepresentationFormat) string {
	if value == nil {
		return "markdown"
	}
	return string(*value)
}

func (a *App) uploadDocument(c *gin.Context) {
	idempotencyKey := contractParams[httpapi.UploadTenantDocumentParams](c).IdempotencyKey
	tenantID := c.Param("tenantId")
	a.uploadDocumentToTarget(c, idempotencyKey, "", "", tenantID)
}

func (a *App) uploadDocumentToTarget(
	c *gin.Context,
	idempotencyKey, kind, contextID, tenantID string,
) {
	upload, err := a.parseDocumentUpload(c)
	if c.Request.MultipartForm != nil {
		defer c.Request.MultipartForm.RemoveAll()
	}
	if err != nil {
		if errors.Is(err, artifactstore.ErrTooLarge) || isMaxBytesError(err) {
			a.writeError(c, http.StatusRequestEntityTooLarge, "PAYLOAD_TOO_LARGE", "Document content exceeds the configured limit")
			return
		}
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Document upload is invalid")
		return
	}
	defer upload.Content.Close()
	input := document.UploadDocumentInput{
		AccountID: currentPrincipal(c).Session.AccountID, TenantID: tenantID, IdempotencyKey: idempotencyKey,
		ParentID: upload.ParentID, Filename: upload.Filename,
		RepresentationFormat: upload.RepresentationFormat, MediaType: upload.MediaType,
		Content: upload.Content,
	}
	var result document.UploadDocumentResult
	if kind == "" {
		result, err = a.documents.Upload(c.Request.Context(), input)
	} else {
		if kind != "wiki" && upload.ParentID != nil {
			a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Context Document upload cannot select a personal parent")
			return
		}
		result, err = a.documents.UploadToContext(c.Request.Context(), document.UploadDocumentContextInput{
			UploadDocumentInput: input, Kind: kind, ContextID: contextID, TenantID: tenantID,
		})
	}
	if a.writeUnifiedDocumentError(c, "upload Document", err) {
		return
	}
	if result.Replayed {
		c.Header("Idempotent-Replay", "true")
	}
	c.JSON(http.StatusCreated, documentModel(result.Document))
}

func (a *App) parseDocumentUpload(c *gin.Context) (documentUpload, error) {
	if err := extendUploadReadDeadline(c); err != nil {
		return documentUpload{}, err
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, a.cfg.ArtifactMaxBytes+(1<<20))
	if err := c.Request.ParseMultipartForm(a.cfg.ArtifactMaxBytes + (1 << 20)); err != nil {
		return documentUpload{}, err
	}
	allowed := map[string]bool{
		"parent_id": true, "filename": true, "representation_format": true, "media_type": true,
	}
	for name, values := range c.Request.MultipartForm.Value {
		if !allowed[name] || len(values) != 1 {
			return documentUpload{}, document.ErrInvalidInput
		}
	}
	for name, files := range c.Request.MultipartForm.File {
		if name != "content" || len(files) != 1 {
			return documentUpload{}, document.ErrInvalidInput
		}
	}
	filename := strings.TrimSpace(c.PostForm("filename"))
	representationFormat := strings.TrimSpace(c.PostForm("representation_format"))
	mediaType := strings.TrimSpace(c.PostForm("media_type"))
	if mediaType == "" {
		mediaType = "application/octet-stream"
	}
	if filename == "" || len(filename) > 255 || representationFormat == "" ||
		len(representationFormat) > 120 || len(mediaType) > 255 {
		return documentUpload{}, document.ErrInvalidInput
	}
	file, header, err := c.Request.FormFile("content")
	if err != nil {
		return documentUpload{}, err
	}
	if header.Size > a.cfg.ArtifactMaxBytes {
		_ = file.Close()
		return documentUpload{}, artifactstore.ErrTooLarge
	}
	var parentID *string
	if value := c.PostForm("parent_id"); value != "" {
		parentID = &value
	}
	return documentUpload{
		ParentID: parentID, Filename: filename, RepresentationFormat: representationFormat,
		MediaType: mediaType, Content: file,
	}, nil
}

func (a *App) uploadDocumentVersion(c *gin.Context, idempotencyKey string) {
	upload, expectedCurrentVersionID, err := a.parseDocumentVersionUpload(c)
	if c.Request.MultipartForm != nil {
		defer c.Request.MultipartForm.RemoveAll()
	}
	if err != nil {
		if errors.Is(err, artifactstore.ErrTooLarge) || isMaxBytesError(err) {
			a.writeError(c, http.StatusRequestEntityTooLarge, "PAYLOAD_TOO_LARGE", "Document content exceeds the configured limit")
			return
		}
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Document Version upload is invalid")
		return
	}
	defer upload.Content.Close()
	result, err := a.documents.UploadVersion(c.Request.Context(), document.UploadDocumentVersionInput{
		AccountID: currentPrincipal(c).Session.AccountID, DocumentID: c.Param("documentId"),
		ExpectedCurrentVersionID: expectedCurrentVersionID, IdempotencyKey: idempotencyKey,
		LinkToken: c.PostForm("link_token"),
		Filename:  upload.Filename, RepresentationFormat: upload.RepresentationFormat,
		MediaType: upload.MediaType, Content: upload.Content,
	})
	if a.writeUnifiedDocumentError(c, "upload Document Version", err) {
		return
	}
	if result.Replayed {
		c.Header("Idempotent-Replay", "true")
	}
	c.JSON(http.StatusCreated, documentVersionModel(result.Version))
}

func (a *App) downloadLatestDocument(c *gin.Context) {
	writeLatestContentCacheHeaders(c)
	content, err := a.documents.GetLatestDownloadContent(c.Request.Context(), document.LatestDownloadInput{
		AccountID:  currentPrincipal(c).Session.AccountID,
		DocumentID: c.Param("documentId"),
	})
	if a.writeUnifiedDocumentError(c, "download latest Document", err) {
		return
	}
	if content.InlineBytes != nil {
		a.writeLatestObjectContentHeaders(c, immutableObjectContent{filename: content.Filename, mediaType: content.MediaType, sha256: content.SHA256, sizeBytes: content.SizeBytes})
		http.ServeContent(c.Writer, c.Request, content.Filename, time.Time{}, bytes.NewReader(content.InlineBytes))
		return
	}

	a.writeLatestObjectContent(c, immutableObjectContent{
		filename: content.Filename, mediaType: content.MediaType,
		objectKey: content.ObjectKey, sha256: content.SHA256,
		sizeBytes: content.SizeBytes,
	})
}

func writeLatestContentCacheHeaders(c *gin.Context) {
	c.Header("Cache-Control", "private, no-store")
}

func (a *App) parseDocumentVersionUpload(c *gin.Context) (documentUpload, string, error) {
	if err := extendUploadReadDeadline(c); err != nil {
		return documentUpload{}, "", err
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, a.cfg.ArtifactMaxBytes+(1<<20))
	if err := c.Request.ParseMultipartForm(a.cfg.ArtifactMaxBytes + (1 << 20)); err != nil {
		return documentUpload{}, "", err
	}
	allowed := map[string]bool{
		"expected_current_version_id": true, "filename": true,
		"representation_format": true, "media_type": true, "link_token": true,
	}
	for name, values := range c.Request.MultipartForm.Value {
		if !allowed[name] || len(values) != 1 {
			return documentUpload{}, "", document.ErrInvalidInput
		}
	}
	for name, files := range c.Request.MultipartForm.File {
		if name != "content" || len(files) != 1 {
			return documentUpload{}, "", document.ErrInvalidInput
		}
	}
	expectedCurrentVersionID := strings.TrimSpace(c.PostForm("expected_current_version_id"))
	filename := strings.TrimSpace(c.PostForm("filename"))
	representationFormat := strings.TrimSpace(c.PostForm("representation_format"))
	mediaType := strings.TrimSpace(c.PostForm("media_type"))
	if mediaType == "" {
		mediaType = "application/octet-stream"
	}
	if expectedCurrentVersionID == "" || filename == "" || len(filename) > 255 ||
		representationFormat == "" || len(representationFormat) > 120 || len(mediaType) > 255 {
		return documentUpload{}, "", document.ErrInvalidInput
	}
	file, header, err := c.Request.FormFile("content")
	if err != nil {
		return documentUpload{}, "", err
	}
	if header.Size > a.cfg.ArtifactMaxBytes {
		_ = file.Close()
		return documentUpload{}, "", artifactstore.ErrTooLarge
	}
	return documentUpload{
		Filename: filename, RepresentationFormat: representationFormat,
		MediaType: mediaType, Content: file,
	}, expectedCurrentVersionID, nil
}

func (a *App) getDocument(c *gin.Context) {
	value, err := a.documents.Get(c.Request.Context(), currentPrincipal(c).Session.AccountID, c.Param("documentId"))
	if a.writeUnifiedDocumentError(c, "get Document", err) {
		return
	}
	c.JSON(http.StatusOK, documentModel(value))
}

func (a *App) updateDocumentMetadata(c *gin.Context) {
	var request httpapi.DocumentMetadataUpdateRequest
	if decodeJSON(c, &request) != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Document metadata input is invalid")
		return
	}
	result, err := a.documents.UpdateMetadata(c.Request.Context(), document.UpdateMetadataInput{
		AccountID: currentPrincipal(c).Session.AccountID, DocumentID: c.Param("documentId"),
		Title: request.Title,
	})
	if a.writeUnifiedDocumentError(c, "update Document metadata", err) {
		return
	}
	c.JSON(http.StatusOK, documentModel(result.Document))
}

func (a *App) updateDocumentDraftTitle(c *gin.Context) {
	var request httpapi.DocumentDraftTitleUpdateRequest
	if decodeJSON(c, &request) != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Document Draft title input is invalid")
		return
	}
	result, err := a.documents.UpdateDraftTitle(c.Request.Context(), document.UpdateDraftTitleInput{
		AccountID: currentPrincipal(c).Session.AccountID, DocumentID: c.Param("documentId"),
		Title: request.Title,
	})
	if a.writeUnifiedDocumentError(c, "update Document Draft title", err) {
		return
	}
	c.JSON(http.StatusOK, documentModel(result.Document))
}

func (a *App) trashDocument(c *gin.Context) {
	err := a.documents.Trash(c.Request.Context(), document.TrashDocumentInput{
		AccountID: currentPrincipal(c).Session.AccountID, DocumentID: c.Param("documentId"),
	})
	if a.writeUnifiedDocumentError(c, "trash Document", err) {
		return
	}
	c.Status(http.StatusNoContent)
}

func (a *App) restoreDocument(c *gin.Context) {
	err := a.documents.Restore(c.Request.Context(), document.RestoreDocumentInput{
		AccountID: currentPrincipal(c).Session.AccountID, DocumentID: c.Param("documentId"),
	})
	if a.writeUnifiedDocumentError(c, "restore Document", err) {
		return
	}
	c.Status(http.StatusNoContent)
}

func (a *App) listLibraryDocuments(c *gin.Context) {
	params := contractParams[httpapi.ListLibraryDocumentsParams](c)
	limit := 50
	if params.Limit != nil {
		limit = *params.Limit
	}
	cursor := ""
	if params.Cursor != nil {
		cursor = *params.Cursor
	}
	page, err := a.documents.List(c.Request.Context(), document.ListInput{
		AccountID: currentPrincipal(c).Session.AccountID,
		View:      document.View(params.View),
		Cursor:    cursor,
		Limit:     limit,
	})
	if a.writeUnifiedDocumentError(c, "list Library Documents", err) {
		return
	}
	items := make([]httpapi.Document, 0, len(page.Items))
	for _, item := range page.Items {
		items = append(items, documentModel(item))
	}
	c.JSON(http.StatusOK, httpapi.DocumentPage{Items: items, Page: documentPageMeta(page.NextCursor, page.HasMore)})
}

func (a *App) listRoomDocuments(c *gin.Context) {
	params := contractParams[httpapi.ListRoomDocumentsParams](c)
	limit := 50
	if params.Limit != nil {
		limit = *params.Limit
	}
	cursor := ""
	if params.Cursor != nil {
		cursor = *params.Cursor
	}
	page, err := a.documents.ListRoom(c.Request.Context(), document.ListRoomInput{
		AccountID: currentPrincipal(c).Session.AccountID,
		RoomID:    c.Param("roomId"),
		Cursor:    cursor,
		Limit:     limit,
	})
	if a.writeUnifiedDocumentError(c, "list Room Documents", err) {
		return
	}
	items := make([]httpapi.Document, 0, len(page.Items))
	for _, item := range page.Items {
		items = append(items, documentModel(item))
	}
	c.JSON(http.StatusOK, httpapi.DocumentPage{Items: items, Page: documentPageMeta(page.NextCursor, page.HasMore)})
}

func (a *App) listPersonalWikiDocuments(c *gin.Context) {
	params := contractParams[httpapi.ListPersonalWikiDocumentsParams](c)
	if _, err := a.currentPersonalWiki(c); a.writePersonalWikiError(c, "authorize Personal Wiki Document list", err) {
		return
	}
	limit := 50
	if params.Limit != nil {
		limit = *params.Limit
	}
	cursor := ""
	if params.Cursor != nil {
		cursor = *params.Cursor
	}
	page, err := a.documents.ListPersonalWiki(c.Request.Context(), document.ListPersonalWikiInput{
		AccountID: currentPrincipal(c).Session.AccountID,
		TenantID:  c.Param("tenantId"),
		Cursor:    cursor,
		Limit:     limit,
	})
	if a.writeUnifiedDocumentError(c, "list Personal Wiki Documents", err) {
		return
	}
	items := make([]httpapi.Document, 0, len(page.Items))
	for _, item := range page.Items {
		items = append(items, documentModel(item))
	}
	c.JSON(http.StatusOK, httpapi.DocumentPage{Items: items, Page: documentPageMeta(page.NextCursor, page.HasMore)})
}

func (a *App) searchLibraryDocuments(c *gin.Context) {
	params := contractParams[httpapi.SearchLibraryDocumentsParams](c)
	limit := 50
	if params.Limit != nil {
		limit = *params.Limit
	}
	input := document.SearchInput{
		AccountID: currentPrincipal(c).Session.AccountID, Query: params.Q, Limit: limit,
	}
	if params.TenantId != nil {
		input.TenantID = *params.TenantId
	}
	if params.Cursor != nil {
		input.Cursor = *params.Cursor
	}
	page, err := a.documents.Search(c.Request.Context(), input)
	if a.writeSearchTimeout(c, err) || a.writeUnifiedDocumentError(c, "search Library Documents", err) {
		return
	}
	items := make([]httpapi.Document, 0, len(page.Items))
	for _, item := range page.Items {
		items = append(items, documentModel(item))
	}
	c.JSON(http.StatusOK, httpapi.DocumentPage{Items: items, Page: documentPageMeta(page.NextCursor, page.HasMore)})
}

func (a *App) listDocumentVersions(c *gin.Context) {
	params := contractParams[httpapi.ListDocumentVersionsParams](c)
	limit := 50
	if params.Limit != nil {
		limit = *params.Limit
	}
	cursor := ""
	if params.Cursor != nil {
		cursor = *params.Cursor
	}
	page, err := a.documents.ListVersions(c.Request.Context(), document.ListVersionsInput{
		AccountID: currentPrincipal(c).Session.AccountID, DocumentID: c.Param("documentId"),
		Cursor: cursor, Limit: limit,
	})
	if a.writeUnifiedDocumentError(c, "list Document Versions", err) {
		return
	}
	items := make([]httpapi.DocumentVersion, 0, len(page.Items))
	for _, item := range page.Items {
		items = append(items, documentVersionModel(item))
	}
	c.JSON(http.StatusOK, httpapi.DocumentVersionPage{Items: items, Page: documentPageMeta(page.NextCursor, page.HasMore)})
}

func (a *App) getDocumentVersion(c *gin.Context) {
	value, err := a.documents.GetVersion(c.Request.Context(), currentPrincipal(c).Session.AccountID,
		c.Param("documentVersionId"))
	if a.writeUnifiedDocumentError(c, "get Document Version", err) {
		return
	}
	c.JSON(http.StatusOK, documentVersionModel(value))
}

func (a *App) downloadDocumentVersion(c *gin.Context) {
	content, err := a.documents.GetVersionContent(c.Request.Context(), currentPrincipal(c).Session.AccountID,
		c.Param("documentVersionId"))
	if a.writeUnifiedDocumentError(c, "download Document Version", err) {
		return
	}
	a.writeImmutableObjectContent(c, immutableObjectContent{
		filename: content.Version.Filename, mediaType: content.Version.MediaType,
		objectKey: content.ObjectKey, sha256: content.Version.SHA256,
		sizeBytes: content.Version.SizeBytes,
	})
}

func (a *App) headDocumentVersionContent(c *gin.Context) {
	content, err := a.documents.GetVersionContent(c.Request.Context(), currentPrincipal(c).Session.AccountID,
		c.Param("documentVersionId"))
	if a.writeUnifiedDocumentError(c, "head Document Version content", err) {
		return
	}
	a.writeImmutableObjectContentHeaders(c, immutableObjectContent{
		filename: content.Version.Filename, mediaType: content.Version.MediaType,
		objectKey: content.ObjectKey, sha256: content.Version.SHA256,
		sizeBytes: content.Version.SizeBytes,
	})
	c.Status(http.StatusOK)
}

func (a *App) listDocumentHistory(c *gin.Context) {
	params := contractParams[httpapi.ListDocumentHistoryParams](c)
	limit := 50
	if params.Limit != nil {
		limit = *params.Limit
	}
	cursor := ""
	if params.Cursor != nil {
		cursor = *params.Cursor
	}
	page, err := a.documents.ListHistory(c.Request.Context(), document.ListHistoryInput{
		AccountID: currentPrincipal(c).Session.AccountID, DocumentID: c.Param("documentId"),
		Cursor: cursor, Limit: limit,
	})
	if a.writeUnifiedDocumentError(c, "list Document History", err) {
		return
	}
	items := make([]httpapi.DocumentHistoryEntry, 0, len(page.Items))
	for _, item := range page.Items {
		items = append(items, documentHistoryEntryModel(item))
	}
	c.JSON(http.StatusOK, httpapi.DocumentHistoryPage{Items: items, Page: documentPageMeta(page.NextCursor, page.HasMore)})
}

func (a *App) getDocumentHistoryContent(c *gin.Context) {
	content, err := a.documents.GetHistoryContent(c.Request.Context(), currentPrincipal(c).Session.AccountID,
		c.Param("historyEntryId"))
	if a.writeUnifiedDocumentError(c, "get Document History content", err) {
		return
	}
	manifest := make([]httpapi.DocumentRevisionInputAsset, 0, len(content.AssetManifest))
	for _, asset := range content.AssetManifest {
		manifest = append(manifest, httpapi.DocumentRevisionInputAsset{
			AssetId: asset.AssetID, Sha256: asset.SHA256, SizeBytes: asset.SizeBytes,
		})
	}
	c.JSON(http.StatusOK, httpapi.DocumentHistoryContent{
		HistoryEntry:         documentHistoryEntryModel(content.HistoryEntry),
		StateBytes:           base64.StdEncoding.EncodeToString(content.StateBytes),
		StateBytesSha256:     content.StateBytesSHA256,
		StateVector:          base64.StdEncoding.EncodeToString(content.StateVector),
		FullStateFingerprint: content.FullStateFingerprint, AssetManifest: manifest,
	})
}

func (a *App) createDocumentHistoryCheckpoint(c *gin.Context) {
	result, err := a.documents.CreateHistoryCheckpoint(c.Request.Context(), document.CreateHistoryCheckpointInput{
		AccountID: currentPrincipal(c).Session.AccountID, DocumentID: c.Param("documentId"),
	})
	if a.writeUnifiedDocumentError(c, "create Document History checkpoint", err) {
		return
	}
	entry := documentHistoryEntryModel(result.HistoryEntry)
	c.JSON(http.StatusOK, httpapi.DocumentHistoryCheckpoint{
		Id: result.ID, DocumentId: result.DocumentID, TargetPersistedSeq: result.TargetPersistedSeq,
		Status: httpapi.DocumentHistoryCheckpointStatus(result.Status), HistoryEntry: &entry,
	})
}

func (a *App) restoreDocumentHistoryEntry(c *gin.Context) {
	result, err := a.documents.RestoreHistoryEntry(c.Request.Context(), document.RestoreHistoryEntryInput{
		AccountID: currentPrincipal(c).Session.AccountID, DocumentID: c.Param("documentId"),
		HistoryEntryID: c.Param("historyEntryId"),
	})
	if a.writeUnifiedDocumentError(c, "restore Document History entry", err) {
		return
	}
	c.JSON(http.StatusOK, httpapi.DocumentHistoryRestoreResult{
		Status:       httpapi.DocumentHistoryRestoreResultStatus(result.Status),
		HistoryEntry: documentHistoryEntryModel(result.HistoryEntry),
	})
}

func (a *App) getMyDocumentTree(c *gin.Context) {
	tenantID := c.Param("tenantId")
	items, err := a.documents.GetMyTree(c.Request.Context(), currentPrincipal(c).Session.AccountID, tenantID)
	if a.writeUnifiedDocumentError(c, "get My Document tree", err) {
		return
	}
	models := make([]httpapi.DocumentPlacementNode, 0, len(items))
	for _, item := range items {
		model, modelErr := documentPlacementModel(item)
		if modelErr != nil {
			a.writeUnifiedDocumentError(c, "map My Document tree", modelErr)
			return
		}
		models = append(models, model)
	}
	c.JSON(http.StatusOK, httpapi.MyDocumentTree{Items: models})
}

func (a *App) getMySharedDocumentTree(c *gin.Context) {
	tenantID := c.Param("tenantId")
	items, err := a.documents.GetSharedTree(c.Request.Context(), currentPrincipal(c).Session.AccountID, tenantID)
	if a.writeUnifiedDocumentError(c, "get shared Document tree", err) {
		return
	}
	models := make([]httpapi.DocumentPlacementNode, 0, len(items))
	for _, item := range items {
		model, modelErr := documentPlacementModel(item)
		if a.writeUnifiedDocumentError(c, "map shared Document tree", modelErr) {
			return
		}
		models = append(models, model)
	}
	c.JSON(http.StatusOK, httpapi.SharedDocumentTree{Items: models})
}

func (a *App) createMySharedDocumentFolder(c *gin.Context) {
	tenantID := c.Param("tenantId")
	var request httpapi.DocumentFolderCreateRequest
	if decodeJSON(c, &request) != nil {
		return
	}
	item, err := a.documents.CreateSharedFolder(c.Request.Context(), document.SharedFolderInput{AccountID: currentPrincipal(c).Session.AccountID, TenantID: tenantID, Name: request.Name, ParentID: request.ParentId})
	if a.writeUnifiedDocumentError(c, "create shared Document folder", err) {
		return
	}
	c.JSON(http.StatusCreated, documentPlacementFolderModel(item))
}

func (a *App) updateMySharedDocumentFolder(c *gin.Context) {
	tenantID := c.Param("tenantId")
	var request httpapi.DocumentPlacementUpdateRequest
	if decodeJSON(c, &request) != nil {
		return
	}
	item, err := a.documents.UpdateSharedFolder(c.Request.Context(), document.UpdateSharedFolderInput{AccountID: currentPrincipal(c).Session.AccountID, TenantID: tenantID, FolderID: c.Param("folderId"), Name: optionalString(request.Name), ParentID: request.ParentId, MoveToRoot: request.MoveToRoot != nil && *request.MoveToRoot})
	if a.writeUnifiedDocumentError(c, "update shared Document folder", err) {
		return
	}
	c.JSON(http.StatusOK, documentPlacementFolderModel(item))
}

func (a *App) deleteMySharedDocumentFolder(c *gin.Context) {
	tenantID := c.Param("tenantId")
	err := a.documents.DeleteSharedFolder(c.Request.Context(), document.DeleteSharedFolderInput{AccountID: currentPrincipal(c).Session.AccountID, TenantID: tenantID, FolderID: c.Param("folderId")})
	if a.writeUnifiedDocumentError(c, "delete shared Document folder", err) {
		return
	}
	c.Status(http.StatusNoContent)
}

func (a *App) moveMySharedDocument(c *gin.Context) {
	tenantID := c.Param("tenantId")
	var request httpapi.SharedDocumentMoveRequest
	if decodeJSON(c, &request) != nil {
		return
	}
	item, err := a.documents.MoveSharedDocument(c.Request.Context(), document.MoveSharedDocumentInput{AccountID: currentPrincipal(c).Session.AccountID, TenantID: tenantID, DocumentID: c.Param("documentId"), ParentID: request.ParentId, MoveToRoot: request.MoveToRoot != nil && *request.MoveToRoot})
	if a.writeUnifiedDocumentError(c, "move shared Document", err) {
		return
	}
	model, err := documentPlacementModel(item)
	if a.writeUnifiedDocumentError(c, "map shared Document", err) {
		return
	}
	response, err := model.AsDocumentPlacementDocument()
	if a.writeUnifiedDocumentError(c, "map shared Document", err) {
		return
	}
	c.JSON(http.StatusOK, response)
}

func (a *App) createMyDocumentFolder(c *gin.Context) {
	tenantID := c.Param("tenantId")
	var request httpapi.DocumentFolderCreateRequest
	if decodeJSON(c, &request) != nil {
		return
	}
	item, err := a.documents.CreateFolder(c.Request.Context(), document.CreateFolderInput{
		AccountID: currentPrincipal(c).Session.AccountID, TenantID: tenantID, ParentID: unifiedDocumentStringIDPointer(request.ParentId),
		Name: request.Name,
	})
	if a.writeUnifiedDocumentError(c, "create My Document Folder", err) {
		return
	}
	c.JSON(http.StatusCreated, documentPlacementFolderModel(item))
}

func (a *App) updateMyDocumentPlacement(c *gin.Context) {
	tenantID := c.Param("tenantId")
	var request httpapi.DocumentPlacementUpdateRequest
	if decodeJSON(c, &request) != nil {
		return
	}
	name := ""
	if request.Name != nil {
		name = *request.Name
	}
	moveToRoot := request.MoveToRoot != nil && *request.MoveToRoot
	item, err := a.documents.UpdatePlacement(c.Request.Context(), document.UpdatePlacementInput{
		AccountID: currentPrincipal(c).Session.AccountID, TenantID: tenantID, PlacementID: c.Param("placementId"),
		Name: name, ParentID: unifiedDocumentStringIDPointer(request.ParentId), MoveToRoot: moveToRoot,
	})
	if a.writeUnifiedDocumentError(c, "update My Document Placement", err) {
		return
	}
	model, err := documentPlacementModel(item)
	if a.writeUnifiedDocumentError(c, "map My Document Placement", err) {
		return
	}
	c.JSON(http.StatusOK, model)
}

func (a *App) deleteMyDocumentFolder(c *gin.Context) {
	tenantID := c.Param("tenantId")
	err := a.documents.DeleteFolder(c.Request.Context(), document.DeleteFolderInput{
		AccountID: currentPrincipal(c).Session.AccountID, TenantID: tenantID, PlacementID: c.Param("placementId"),
	})
	if a.writeUnifiedDocumentError(c, "delete My Document Folder", err) {
		return
	}
	c.Status(http.StatusNoContent)
}

func documentModel(value document.Document) httpapi.Document {
	model := httpapi.Document{
		Id: value.ID, TenantId: value.TenantID, Title: value.Title, Format: value.Format,
		RepresentationFormat: value.RepresentationFormat,
		Owner:                unifiedDocumentActorModel(value.Owner), Creator: unifiedDocumentActorModel(value.Creator),
		Status:               httpapi.UnifiedDocumentStatus(value.Status),
		DraftCapability:      httpapi.DocumentDraftCapability(value.DraftCapability),
		CanEditNativeContent: value.CanEditNativeContent,
		Capabilities:         documentCapabilitiesModel(value.Capabilities),
		From:                 make([]httpapi.UnifiedDocumentFrom, 0, len(value.From)),
		CreatedAt:            value.CreatedAt, UpdatedAt: value.UpdatedAt,
	}
	if value.CurrentVersion != nil {
		model.CurrentVersion = &httpapi.UnifiedDocumentVersionRef{
			Id: value.CurrentVersion.ID, VersionNumber: value.CurrentVersion.VersionNumber,
			Sha256: value.CurrentVersion.SHA256,
		}
	}
	if value.SearchMatch != nil {
		match := &httpapi.DocumentSearchMatch{
			BodyIndexStatus: httpapi.DocumentSearchMatchBodyIndexStatus(value.SearchMatch.BodyIndexStatus),
		}
		if value.SearchMatch.BodySnippet != "" {
			snippet := value.SearchMatch.BodySnippet
			match.BodySnippet = &snippet
		}
		model.SearchMatch = match
	}
	if value.AccessV2 != nil {
		access := &httpapi.DocumentAccessEnvelopeV2{
			SchemaVersion: value.AccessV2.SchemaVersion,
			ContentRole:   httpapi.DocumentContentRoleV2(value.AccessV2.ContentRole),
			Sources:       make([]httpapi.DocumentAccessSourceV2, 0, len(value.AccessV2.Sources)),
			Policy: httpapi.DocumentAccessPolicyV2{
				SchemaVersion: 2,
				LinkScope:     httpapi.DocumentLinkScopeV2(value.AccessV2.LinkScope),
			},
			AuthorizationMode: httpapi.DocumentAuthorizationModeV2(value.AccessV2.AuthorizationMode),
		}
		for _, source := range value.AccessV2.Sources {
			access.Sources = append(access.Sources, documentAccessSourceModel(source))
		}
		model.AccessV2 = access
	}
	for _, source := range value.From {
		item := httpapi.UnifiedDocumentFrom{
			BindingKind: httpapi.UnifiedDocumentFromBindingKind(source.BindingKind),
			ContextId:   source.ContextID, Label: &source.Label,
		}
		// Page paths belong to the Wiki binding, not the shared Document identity.
		if source.PageKey != "" {
			pageKey := source.PageKey
			item.PageKey = &pageKey
		}
		model.From = append(model.From, item)
	}
	return model
}

func documentAccessSourceModel(source document.AccessSourceV2) httpapi.DocumentAccessSourceV2 {
	provenance := httpapi.DocumentAccessSourceProvenanceV2{
		SchemaVersion:     source.Provenance.SchemaVersion,
		Kind:              httpapi.DocumentAccessSourceProvenanceV2Kind(source.Provenance.Kind),
		ContextId:         unifiedDocumentIDPointer(source.Provenance.ContextID),
		MessageId:         unifiedDocumentIDPointer(source.Provenance.MessageID),
		MembershipEpochId: unifiedDocumentIDPointer(source.Provenance.MembershipEpochID),
	}
	if source.Provenance.MembershipMode != nil {
		mode := httpapi.DocumentAccessSourceProvenanceV2MembershipMode(*source.Provenance.MembershipMode)
		provenance.MembershipMode = &mode
	}
	if source.Provenance.BindingKind != nil {
		bindingKind := httpapi.DocumentAccessSourceProvenanceV2BindingKind(*source.Provenance.BindingKind)
		provenance.BindingKind = &bindingKind
	}
	mapped := httpapi.DocumentAccessSourceV2{
		SchemaVersion: source.SchemaVersion, SourceId: source.SourceID,
		SourceVersion: source.SourceVersion, SourceKind: httpapi.DocumentAccessSourceKindV2(source.SourceKind),
		Status: httpapi.DocumentAccessSourceStatusV2(source.Status), Role: httpapi.DocumentContentRoleV2(source.Role),
		GrantorActorId: unifiedDocumentIDPointer(source.GrantorActorID), Provenance: provenance,
		CreatedAt: source.CreatedAt, UpdatedAt: source.UpdatedAt,
	}
	if source.Target != nil {
		mapped.Target = &httpapi.DocumentAccessTargetV2{
			Kind: httpapi.DocumentAccessTargetV2Kind(source.Target.Kind), Id: source.Target.ID,
		}
	}
	return mapped
}

func (a *App) removeDocumentFromRoom(c *gin.Context) {
	var request httpapi.DocumentRoomBindingRemoveRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Document Room removal request is invalid")
		return
	}
	result, err := a.documents.RemoveFromRoom(c.Request.Context(), document.RemoveRoomBindingInput{
		AccountID: currentPrincipal(c).Session.AccountID, DocumentID: c.Param("documentId"),
		RoomID: c.Param("roomId"), ExpectedVersion: request.ExpectedVersion,
	})
	if a.writeUnifiedDocumentError(c, "remove Document from Room", err) {
		return
	}
	c.JSON(http.StatusOK, documentRoomBindingModel(result))
}

func documentRoomBindingModel(value document.RoomBindingResult) httpapi.DocumentRoomBindingResultV1 {
	return httpapi.DocumentRoomBindingResultV1{
		BindingId: value.BindingID, DocumentId: value.DocumentID, RoomId: value.RoomID,
		Role:   httpapi.DocumentRoomBindingResultV1Role(value.Role),
		Status: httpapi.DocumentRoomBindingResultV1Status(value.Status), Version: value.Version,
	}
}

func (a *App) createDocumentDirectCollaborator(c *gin.Context) {
	var request httpapi.DocumentDirectCollaboratorCreateRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Document collaborator request is invalid")
		return
	}
	result, err := a.documents.CreateDirectCollaborator(c.Request.Context(), document.CreateDirectCollaboratorInput{
		AccountID: currentPrincipal(c).Session.AccountID, DocumentID: c.Param("documentId"),
		TargetActorID: request.TargetActorId, Role: string(request.Role),
	})
	if a.writeUnifiedDocumentError(c, "create Document Direct collaborator", err) {
		return
	}
	c.JSON(http.StatusCreated, documentAccessSourceModel(result.Source))
}

func (a *App) getDocumentShareView(c *gin.Context) {
	view, err := a.documents.GetShareView(c.Request.Context(),
		currentPrincipal(c).Session.AccountID, c.Param("documentId"))
	if a.writeUnifiedDocumentError(c, "get Document Share view", err) {
		return
	}
	capabilities := httpapi.DocumentManagementCapabilitiesV2{
		CanChangeOwnership:      view.ManagementCapabilities.CanChangeOwnership,
		CanUpdateLinkPolicy:     view.ManagementCapabilities.CanUpdateLinkPolicy,
		CanUpdateExternalPolicy: view.ManagementCapabilities.CanUpdateExternalPolicy,
	}
	model := httpapi.DocumentShareViewV2{
		SchemaVersion: view.SchemaVersion, CallerContentRole: httpapi.DocumentContentRoleV2(view.CallerContentRole),
		CanManageCollaborators: view.CanManageCollaborators,
		ManagementCapabilities: &capabilities, Sources: make([]httpapi.DocumentShareSourceV2, 0, len(view.Sources)),
	}
	linkScope := httpapi.DocumentLinkScopeV2(view.GeneralAccess.Scope)
	model.GeneralAccess = &httpapi.DocumentGeneralAccessV1{
		Scope: linkScope, CanonicalUrl: view.GeneralAccess.CanonicalURL,
	}
	for _, source := range view.Sources {
		item := httpapi.DocumentShareSourceV2{Label: source.Label, Source: documentAccessSourceModel(source.Source)}
		group := httpapi.DocumentShareSourceV2SourceGroup(source.SourceGroup)
		state := httpapi.DocumentShareSourceV2CallerAccessState(source.CallerAccessState)
		item.SourceGroup = &group
		item.CallerAccessState = &state
		if source.TargetActor != nil {
			target := unifiedDocumentActorModel(*source.TargetActor)
			item.TargetActor = &target
		}
		model.Sources = append(model.Sources, item)
	}
	c.JSON(http.StatusOK, model)
}

func (a *App) listDocumentAgentMentionCandidates(c *gin.Context) {
	params := contractParams[httpapi.ListDocumentAgentMentionCandidatesParams](c)
	cursor, limit := "", 50
	if params.Cursor != nil {
		cursor = *params.Cursor
	}
	if params.Limit != nil {
		limit = *params.Limit
	}
	page, err := a.documents.ListAgentMentionCandidates(c.Request.Context(),
		currentPrincipal(c).Session.AccountID, c.Param("documentId"), cursor, limit)
	if a.writeUnifiedDocumentError(c, "list Document Agent Mention candidates", err) {
		return
	}
	items := make([]httpapi.DocumentAgentMentionCandidateV1, 0, len(page.Items))
	for _, candidate := range page.Items {
		item := httpapi.DocumentAgentMentionCandidateV1{
			Actor: unifiedDocumentActorModel(candidate.Actor), AgentManagementId: candidate.AgentManagementID,
			Relationship: httpapi.DocumentAgentMentionRelationshipV1(candidate.Relationship),
		}
		items = append(items, item)
	}
	c.JSON(http.StatusOK, httpapi.DocumentAgentMentionCandidatePageV1{
		Items: items, Page: documentPageMeta(page.NextCursor, page.HasMore),
	})
}

func (a *App) updateDocumentDirectCollaborator(c *gin.Context) {
	var request httpapi.DocumentDirectCollaboratorUpdateRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Document collaborator request is invalid")
		return
	}
	result, err := a.documents.UpdateDirectCollaborator(c.Request.Context(), document.UpdateDirectCollaboratorInput{
		AccountID: currentPrincipal(c).Session.AccountID, DocumentID: c.Param("documentId"),
		SourceID: c.Param("sourceId"), ExpectedVersion: request.ExpectedVersion,
		Role: string(request.Role),
	})
	if a.writeUnifiedDocumentError(c, "update Document Direct collaborator", err) {
		return
	}
	c.JSON(http.StatusOK, documentAccessSourceModel(result.Source))
}

func (a *App) revokeDocumentDirectCollaborator(c *gin.Context) {
	var request httpapi.DocumentDirectCollaboratorRevokeRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Document collaborator request is invalid")
		return
	}
	result, err := a.documents.RevokeDirectCollaborator(c.Request.Context(), document.RevokeDirectCollaboratorInput{
		AccountID: currentPrincipal(c).Session.AccountID, DocumentID: c.Param("documentId"),
		SourceID: c.Param("sourceId"), ExpectedVersion: request.ExpectedVersion,
	})
	if a.writeUnifiedDocumentError(c, "revoke Document Direct collaborator", err) {
		return
	}
	c.JSON(http.StatusOK, documentAccessSourceModel(result.Source))
}

func documentCapabilitiesModel(value document.Capabilities) httpapi.UnifiedDocumentCapabilities {
	return httpapi.UnifiedDocumentCapabilities{
		Read: value.Read, Write: value.Write, Manage: value.Manage, Delete: value.Delete,
		Duplicate: value.Duplicate, Export: value.Export, Comment: value.Comment,
		UseAsContext: value.UseAsContext,
	}
}

func documentVersionModel(value document.Version) httpapi.DocumentVersion {
	model := httpapi.DocumentVersion{
		Id: value.ID, DocumentId: value.DocumentID, VersionNumber: value.VersionNumber,
		Filename: value.Filename, RepresentationFormat: value.RepresentationFormat,
		MediaType: value.MediaType, SizeBytes: value.SizeBytes, Sha256: value.SHA256,
		CreatedBy: unifiedDocumentActorModel(value.CreatedBy), Source: httpapi.DocumentVersionSource(value.Source),
		CreatedAt: value.CreatedAt,
	}
	model.SourceRevisionId = unifiedDocumentIDPointer(value.SourceRevisionID)
	model.BaseVersionId = unifiedDocumentIDPointer(value.BaseVersionID)
	model.SourceInvocationId = unifiedDocumentIDPointer(value.SourceInvocationID)
	if value.ExporterSchemaVersion > 0 {
		model.ExporterSchemaVersion = &value.ExporterSchemaVersion
	}
	return model
}

func documentHistoryEntryModel(value document.HistoryEntry) httpapi.DocumentHistoryEntry {
	contributors := make([]httpapi.UnifiedDocumentActor, 0, len(value.Contributors))
	for _, contributor := range value.Contributors {
		contributors = append(contributors, unifiedDocumentActorModel(contributor))
	}
	return httpapi.DocumentHistoryEntry{
		Id: value.ID, DocumentId: value.DocumentID, RevisionId: value.RevisionID,
		PersistedSeq: value.PersistedSeq, CreatedBy: unifiedDocumentActorModel(value.CreatedBy),
		Contributors: contributors, Trigger: httpapi.DocumentHistoryTrigger(value.Trigger), CreatedAt: value.CreatedAt,
	}
}

func unifiedDocumentActorModel(value document.Actor) httpapi.ActorRef {
	return httpapi.ActorRef{Id: value.ID, TenantId: value.TenantID, Kind: httpapi.ActorKind(value.Kind), DisplayName: value.DisplayName}
}

func unifiedDocumentIDPointer(value *string) *httpapi.Id {
	if value == nil {
		return nil
	}
	converted := *value
	return &converted
}

func unifiedDocumentStringIDPointer(value *httpapi.Id) *string {
	if value == nil {
		return nil
	}
	converted := *value
	return &converted
}

func documentPlacementFolderModel(value document.Placement) httpapi.DocumentPlacementFolder {
	return httpapi.DocumentPlacementFolder{
		Id: value.ID, NodeKind: "folder", Name: value.Name, ParentId: unifiedDocumentIDPointer(value.ParentID),
		SortKey: value.SortKey, CreatedAt: value.CreatedAt, UpdatedAt: value.UpdatedAt,
	}
}

func documentPlacementModel(value document.Placement) (httpapi.DocumentPlacementNode, error) {
	model := httpapi.DocumentPlacementNode{}
	if value.NodeKind == "folder" {
		return model, model.FromDocumentPlacementFolder(documentPlacementFolderModel(value))
	}
	if value.NodeKind == "document" {
		if value.Document == nil {
			return model, document.ErrInvalidInput
		}
		err := model.FromDocumentPlacementDocument(httpapi.DocumentPlacementDocument{
			Id: value.ID, NodeKind: "document", DocumentId: value.DocumentID,
			Document: documentTreeSummaryModel(*value.Document),
			ParentId: unifiedDocumentIDPointer(value.ParentID), SortKey: value.SortKey,
			CreatedAt: value.CreatedAt, UpdatedAt: value.UpdatedAt,
		})
		return model, err
	}
	return model, document.ErrInvalidInput
}

func documentTreeSummaryModel(value document.PlacementDocumentSummary) httpapi.DocumentTreeSummary {
	model := httpapi.DocumentTreeSummary{
		Id: value.ID, Title: value.Title, Format: value.Format,
		RepresentationFormat: value.RepresentationFormat,
		Status:               httpapi.UnifiedDocumentStatus(value.Status), Owner: unifiedDocumentActorModel(value.Owner),
		Capabilities: httpapi.UnifiedDocumentCapabilities{
			Read: value.Capabilities.Read, Write: value.Capabilities.Write, Manage: value.Capabilities.Manage,
			Delete: value.Capabilities.Delete, Duplicate: value.Capabilities.Duplicate,
			Export: value.Capabilities.Export, Comment: value.Capabilities.Comment,
			UseAsContext: value.Capabilities.UseAsContext,
		},
		CanEditNativeContent: value.CanEditNativeContent, UpdatedAt: value.UpdatedAt,
	}
	if value.AccessSources != nil {
		sources := make([]httpapi.DocumentAccessSourceV2, 0, len(value.AccessSources))
		for _, source := range value.AccessSources {
			sources = append(sources, documentAccessSourceModel(source))
		}
		model.AccessSources = &sources
	}
	return model
}

func documentPageMeta(cursor string, hasMore bool) httpapi.PageMeta {
	meta := httpapi.PageMeta{HasMore: hasMore}
	if cursor != "" {
		value := cursor
		meta.NextCursor = &value
	}
	return meta
}

func (a *App) writeUnifiedDocumentError(c *gin.Context, action string, err error) bool {
	if err == nil {
		return false
	}
	switch {
	case errors.Is(err, document.ErrInvalidInput):
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "Document request is invalid")
	case errors.Is(err, document.ErrNotFound):
		a.writeError(c, http.StatusNotFound, "NOT_FOUND", "Document was not found")
	case errors.Is(err, document.ErrIdempotencyConflict):
		a.writeError(c, http.StatusConflict, "IDEMPOTENCY_KEY_REUSED", "Idempotency key was reused with a different request")
	case errors.Is(err, document.ErrVersionConflict):
		a.writeError(c, http.StatusConflict, "DOCUMENT_VERSION_CONFLICT", "Document current Version changed")
	case errors.Is(err, document.ErrCollaboratorConflict):
		a.writeError(c, http.StatusConflict, "DOCUMENT_COLLABORATOR_CONFLICT", "Document collaborator changed; refresh and try again")
	case errors.Is(err, document.ErrFolderNotEmpty):
		a.writeError(c, http.StatusConflict, "DOCUMENT_FOLDER_NOT_EMPTY", "Document Folder is not empty")
	case errors.Is(err, document.ErrFolderNameTaken):
		a.writeError(c, http.StatusConflict, "DOCUMENT_FOLDER_NAME_TAKEN", "A folder with this name already exists here")
	case errors.Is(err, document.ErrConflict):
		a.writeError(c, http.StatusConflict, "DOCUMENT_TREE_CONFLICT", "Document tree changed concurrently")
	case errors.Is(err, document.ErrLatestProjectionNotReady):
		writeLatestContentCacheHeaders(c)
		c.Header("Retry-After", "1")
		a.writeError(c, http.StatusAccepted, "DOCUMENT_LATEST_NOT_READY", "Document latest changed during rendering; retry")
	case errors.Is(err, document.ErrRuntimeUnavailable):
		a.writeError(c, http.StatusServiceUnavailable, "DOCUMENT_RUNTIME_UNAVAILABLE", "Document Runtime is unavailable")
	case errors.Is(err, document.ErrRecoveryBudgetExceeded):
		a.writeError(c, http.StatusRequestEntityTooLarge, "PAYLOAD_TOO_LARGE", "Document content exceeds the recovery limit")
	case errors.Is(err, artifactstore.ErrTooLarge):
		a.writeError(c, http.StatusRequestEntityTooLarge, "PAYLOAD_TOO_LARGE", "Document content exceeds the configured limit")
	case errors.Is(err, document.ErrObjectStoreUnavailable):
		a.writeError(c, http.StatusServiceUnavailable, "DOCUMENT_OBJECT_STORE_UNAVAILABLE", "Document storage is unavailable")
	case errors.Is(err, document.ErrRevisionUnavailable):
		a.writeError(c, http.StatusServiceUnavailable, "DOCUMENT_REVISION_UNAVAILABLE", "Document Revision content is unavailable")
	default:
		a.internalError(c, action, err)
	}
	return true
}

func (a *App) uploadRoomDocument(c *gin.Context) {
	params := contractParams[httpapi.UploadRoomDocumentParams](c)
	a.uploadDocumentToTarget(c, params.IdempotencyKey, "room", c.Param("roomId"), "")
}

func (a *App) uploadWorkItemDocument(c *gin.Context) {
	params := contractParams[httpapi.UploadWorkItemDocumentParams](c)
	a.uploadDocumentToTarget(c, params.IdempotencyKey, "task", c.Param("workItemId"), "")
}

func (a *App) uploadPersonalWikiDocument(c *gin.Context) {
	params := contractParams[httpapi.UploadPersonalWikiDocumentParams](c)
	a.uploadDocumentToTarget(c, params.IdempotencyKey, "wiki", "", c.Param("tenantId"))
}

func (a *App) uploadDocumentVersionRoute(c *gin.Context) {
	params := contractParams[httpapi.UploadDocumentVersionParams](c)
	a.uploadDocumentVersion(c, params.IdempotencyKey)
}
