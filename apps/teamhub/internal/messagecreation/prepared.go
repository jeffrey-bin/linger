package messagecreation

func normalizePreparedAttachments(segments []Segment, attachments []Attachment) ([]Attachment, error) {
	byVersion := make(map[string]Attachment, len(attachments))
	for _, a := range attachments {
		if a.DocumentID == "" || a.DocumentVersionID == "" || a.Filename == "" || a.MediaType == "" || a.SizeBytes < 0 || a.SHA256 == "" {
			return nil, ErrInvalid
		}
		if _, ok := byVersion[a.DocumentVersionID]; ok {
			return nil, ErrInvalid
		}
		byVersion[a.DocumentVersionID] = a
	}
	used := make(map[string]bool)
	fragments := 0
	for _, s := range segments {
		switch s.Type {
		case "file":
			a, ok := byVersion[s.DocumentVersionID]
			if !ok || a.DocumentID != s.DocumentID {
				return nil, ErrInvalid
			}
			used[s.DocumentVersionID] = true
		case "html_fragment":
			fragments++
		}
	}
	// HTML fragments are the only attachments intentionally absent from file segments.
	if len(byVersion)-len(used) != fragments {
		return nil, ErrInvalid
	}
	for version, a := range byVersion {
		if !used[version] && a.MediaType != "text/html" && a.MediaType != "image/svg+xml" {
			return nil, ErrInvalid
		}
	}
	return append([]Attachment{}, attachments...), nil
}
func preparedVisibleAttachments(segments []Segment, attachments []Attachment) []Attachment {
	visible := map[string]bool{}
	for _, s := range segments {
		if s.Type == "file" {
			visible[s.DocumentVersionID] = true
		}
	}
	result := make([]Attachment, 0, len(visible))
	for _, a := range attachments {
		if visible[a.DocumentVersionID] {
			result = append(result, a)
		}
	}
	return result
}
