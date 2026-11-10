package app

import (
	"github.com/gin-gonic/gin"
)

func (a *App) archiveWorkItem(c *gin.Context) {
	a.setWorkItemArchived(c, true)
}

func (a *App) unarchiveWorkItem(c *gin.Context) {
	a.setWorkItemArchived(c, false)
}
