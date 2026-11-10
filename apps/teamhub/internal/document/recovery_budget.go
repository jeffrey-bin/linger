package document

// requireStateBundleBudget rejects a head the Runtime could not open.
func requireStateBundleBudget(stateBytes, stateVector []byte, assetIDs, threadIDs []string) error {
	if !BundleFits(len(stateBytes), len(stateVector), assetIDs, threadIDs) {
		return ErrRecoveryBudgetExceeded
	}
	return nil
}
