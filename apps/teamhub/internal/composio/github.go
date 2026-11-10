package composio

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type GitHubIdentity struct {
	UserID, Login, Name, Bio, Location, Blog, HTMLURL string
}

type GitHubRepository struct {
	RepositoryID, OwnerID, OwnerLogin, Name, FullName, HTMLURL, Description, Homepage, Language, DefaultBranch string
	Topics                                                                                                     []string
	Stargazers, Forks                                                                                          int
	UpdatedAt                                                                                                  time.Time
}

type GitHubRepositoryPage struct {
	Repositories []GitHubRepository
	NextCursor   string
}

type GitHubReadme struct {
	Path, SHA, HTMLURL string
	Content            []byte
}

type GitHubRepositorySnapshot struct {
	Repository GitHubRepository
	Readme     *GitHubReadme
}

func (c *Client) IdentifyGitHub(ctx context.Context, connectedAccountID string) (GitHubIdentity, error) {
	var wire struct {
		ID       int64  `json:"id"`
		Login    string `json:"login"`
		Name     string `json:"name"`
		Bio      string `json:"bio"`
		Location string `json:"location"`
		Blog     string `json:"blog"`
		HTMLURL  string `json:"html_url"`
	}
	if err := c.proxy(ctx, proxyRequest{ConnectedAccountID: connectedAccountID, Endpoint: "/user", Method: http.MethodGet}, &wire, "identify GitHub account"); err != nil {
		return GitHubIdentity{}, err
	}
	if wire.ID <= 0 || strings.TrimSpace(wire.Login) == "" {
		return GitHubIdentity{}, errors.New("GitHub identity response was incomplete")
	}
	return GitHubIdentity{UserID: strconv.FormatInt(wire.ID, 10), Login: wire.Login, Name: wire.Name, Bio: wire.Bio, Location: wire.Location, Blog: wire.Blog, HTMLURL: wire.HTMLURL}, nil
}

func (c *Client) ListGitHubRepositories(ctx context.Context, connectedAccountID string, identity GitHubIdentity, cursor string, limit int) (GitHubRepositoryPage, error) {
	if identity.UserID == "" || identity.Login == "" || limit < 1 || limit > 100 {
		return GitHubRepositoryPage{}, errors.New("invalid GitHub repository page request")
	}
	pageNumber := 1
	if cursor != "" {
		parsed, err := strconv.Atoi(cursor)
		if err != nil || parsed < 2 {
			return GitHubRepositoryPage{}, errors.New("invalid GitHub repository cursor")
		}
		pageNumber = parsed
	}
	parameters := []proxyParameter{
		{Name: "visibility", Value: "public", Type: "query"},
		{Name: "affiliation", Value: "owner", Type: "query"},
		{Name: "sort", Value: "updated", Type: "query"},
		{Name: "direction", Value: "desc", Type: "query"},
		{Name: "per_page", Value: strconv.Itoa(limit), Type: "query"},
		{Name: "page", Value: strconv.Itoa(pageNumber), Type: "query"},
	}
	var wire []struct {
		ID            int64     `json:"id"`
		Name          string    `json:"name"`
		FullName      string    `json:"full_name"`
		Private       bool      `json:"private"`
		Fork          bool      `json:"fork"`
		Archived      bool      `json:"archived"`
		HTMLURL       string    `json:"html_url"`
		Description   string    `json:"description"`
		Homepage      string    `json:"homepage"`
		Language      string    `json:"language"`
		Topics        []string  `json:"topics"`
		Stargazers    int       `json:"stargazers_count"`
		Forks         int       `json:"forks_count"`
		DefaultBranch string    `json:"default_branch"`
		UpdatedAt     time.Time `json:"updated_at"`
		Owner         struct {
			ID    int64  `json:"id"`
			Login string `json:"login"`
		} `json:"owner"`
	}
	if err := c.proxy(ctx, proxyRequest{ConnectedAccountID: connectedAccountID, Endpoint: "/user/repos", Method: http.MethodGet, Parameters: parameters}, &wire, "list GitHub repositories"); err != nil {
		return GitHubRepositoryPage{}, err
	}
	result := GitHubRepositoryPage{}
	for _, repository := range wire {
		ownerID := strconv.FormatInt(repository.Owner.ID, 10)
		if repository.ID <= 0 || repository.Name == "" || repository.FullName == "" || repository.Private || repository.Fork || repository.Archived || ownerID != identity.UserID || !strings.EqualFold(repository.Owner.Login, identity.Login) {
			continue
		}
		result.Repositories = append(result.Repositories, GitHubRepository{
			RepositoryID: strconv.FormatInt(repository.ID, 10), OwnerID: ownerID, OwnerLogin: repository.Owner.Login,
			Name: repository.Name, FullName: repository.FullName, HTMLURL: repository.HTMLURL, Description: repository.Description,
			Homepage: repository.Homepage, Language: repository.Language, Topics: repository.Topics, Stargazers: repository.Stargazers,
			Forks: repository.Forks, DefaultBranch: repository.DefaultBranch,
			UpdatedAt: repository.UpdatedAt,
		})
	}
	if len(wire) == limit {
		result.NextCursor = strconv.Itoa(pageNumber + 1)
	}
	return result, nil
}

func (c *Client) GetGitHubReadme(ctx context.Context, connectedAccountID string, repository GitHubRepository) (*GitHubReadme, error) {
	if repository.OwnerLogin == "" || repository.Name == "" {
		return nil, errors.New("invalid GitHub repository")
	}
	var wire struct {
		Path     string `json:"path"`
		SHA      string `json:"sha"`
		HTMLURL  string `json:"html_url"`
		Encoding string `json:"encoding"`
		Content  string `json:"content"`
		Size     int    `json:"size"`
	}
	endpoint := "/repos/" + url.PathEscape(repository.OwnerLogin) + "/" + url.PathEscape(repository.Name) + "/readme"
	err := c.proxy(ctx, proxyRequest{ConnectedAccountID: connectedAccountID, Endpoint: endpoint, Method: http.MethodGet, Parameters: []proxyParameter{{Name: "ref", Value: repository.DefaultBranch, Type: "query"}}}, &wire, "get GitHub repository README")
	if status, ok := ErrorStatus(err); ok && status == http.StatusNotFound {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if wire.Encoding != "base64" || wire.Path == "" || wire.SHA == "" || wire.Size < 0 || wire.Size > c.maxThreadBytes {
		return nil, errors.New("GitHub README response was invalid or too large")
	}
	content, err := base64.StdEncoding.DecodeString(strings.ReplaceAll(wire.Content, "\n", ""))
	if err != nil || len(content) != wire.Size || len(content) > c.maxThreadBytes {
		return nil, errors.New("GitHub README response was invalid or too large")
	}
	return &GitHubReadme{Path: wire.Path, SHA: wire.SHA, HTMLURL: wire.HTMLURL, Content: content}, nil
}

func RenderGitHubDocumentsWithLimits(identity GitHubIdentity, snapshots []GitHubRepositorySnapshot, limits AppImportLimits) ([]AppDocument, error) {
	if identity.UserID == "" || identity.Login == "" || len(snapshots) > 5 {
		return nil, errors.New("invalid GitHub snapshot")
	}
	limits = NormalizeAppImportLimits(limits)
	renderedTotal := 0
	profile := newAppDocumentBuilder(limits, &renderedTotal)
	_, _ = fmt.Fprintf(profile, "# GitHub profile\n\n- Login: @%s\n- GitHub user ID: %s\n- Canonical URL: %s\n- Provenance: github_profile\n", safeAppText(identity.Login), safeAppText(identity.UserID), safeAppText(identity.HTMLURL))
	for label, value := range map[string]string{"Name": identity.Name, "Bio (user-provided)": identity.Bio, "Location (user-provided)": identity.Location, "Website (user-provided)": identity.Blog} {
		if strings.TrimSpace(value) != "" {
			_, _ = fmt.Fprintf(profile, "- %s: %s\n", label, safeAppText(value))
		}
	}
	profileContent, err := profile.Content()
	if err != nil {
		return nil, err
	}
	documents := []AppDocument{{RemoteID: "github:profile:" + identity.UserID, Filename: boundedAppFilename("github-profile", identity.Login, identity.UserID, "snapshot"), Markdown: profileContent}}
	seen := map[string]bool{}
	for _, snapshot := range snapshots {
		repository := snapshot.Repository
		if repository.RepositoryID == "" || repository.OwnerID != identity.UserID || repository.FullName == "" || seen[repository.RepositoryID] {
			return nil, errors.New("invalid GitHub repository snapshot")
		}
		seen[repository.RepositoryID] = true
		output := newAppDocumentBuilder(limits, &renderedTotal)
		_, _ = fmt.Fprintf(output, "# %s\n\n- Repository ID: %s\n- Full name: %s\n- Canonical URL: %s\n- Default branch: %s\n- Language: %s\n- Stars: %d\n- Forks: %d\n- Provenance: github_repository\n", safeAppText(repository.Name), safeAppText(repository.RepositoryID), safeAppText(repository.FullName), safeAppText(repository.HTMLURL), safeAppText(repository.DefaultBranch), safeAppText(repository.Language), repository.Stargazers, repository.Forks)
		if repository.Description != "" {
			_, _ = fmt.Fprintf(output, "- Description: %s\n", safeAppText(repository.Description))
		}
		if len(repository.Topics) > 0 {
			_, _ = fmt.Fprintf(output, "- Topics: %s\n", safeAppText(strings.Join(repository.Topics, ", ")))
		}
		if snapshot.Readme == nil {
			_, _ = output.WriteString("- README: unavailable\n")
		} else {
			_, _ = fmt.Fprintf(output, "- README path: %s\n- README SHA: %s\n- README URL: %s\n\n## README\n\n", safeAppText(snapshot.Readme.Path), safeAppText(snapshot.Readme.SHA), safeAppText(snapshot.Readme.HTMLURL))
			_, _ = output.Write(snapshot.Readme.Content)
			_, _ = output.WriteString("\n")
		}
		content, contentErr := output.Content()
		if contentErr != nil {
			return nil, contentErr
		}
		documents = append(documents, AppDocument{RemoteID: "github:repository:" + repository.RepositoryID, Filename: boundedAppFilename("github-repository", repository.Name, repository.RepositoryID, "snapshot"), Markdown: content})
	}
	return documents, nil
}
