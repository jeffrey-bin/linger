package integration_test

// roomDocumentResponse is the shared native Draft projection used by the
// collaboration, Comment, Asset, and Runtime public-seam acceptance tests.
type roomDocumentResponse struct {
	ID          string `json:"id"`
	DurableHead struct {
		PersistedSeq     int64  `json:"persisted_seq"`
		StateVector      string `json:"state_vector"`
		StateHash        string `json:"state_hash"`
		StateHashVersion int    `json:"state_hash_version"`
	} `json:"durable_head"`
}
