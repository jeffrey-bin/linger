package app

import (
	"testing"

	"github.com/gin-gonic/gin"
)

func TestGeneratedContractRoutesRegisterTogether(t *testing.T) {
	// Public and callback APIs share one Gin tree. Wildcard names must agree
	// across generated contracts, even when the final path segments differ.
	(&App{}).registerContractRoutes(gin.New())
}
