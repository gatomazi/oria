package main

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func postMediaUpload(t *testing.T, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/media/upload", strings.NewReader(body))
	rec := httptest.NewRecorder()
	handleMediaUpload(rec, req)
	return rec
}

func TestGivenAppIDWithNonDigits_WhenUploading_ThenRejectsBeforeCallingMeta(t *testing.T) {
	// Given
	cfg = Config{AppID: "123456789"}
	body := `{"mimeType":"image/png","dataBase64":"aGVsbG8=","appId":"123/../me"}`

	// When
	rec := postMediaUpload(t, body)

	// Then
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d (body %s)", rec.Code, http.StatusBadRequest, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "appId inválido") {
		t.Fatalf("body = %s, want appId inválido", rec.Body.String())
	}
}

func TestGivenNoAppIDInRequestOrEnv_WhenUploading_ThenReturnsConfigurationError(t *testing.T) {
	// Given
	cfg = Config{}
	body := `{"mimeType":"image/png","dataBase64":"aGVsbG8="}`

	// When
	rec := postMediaUpload(t, body)

	// Then
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want %d (body %s)", rec.Code, http.StatusBadGateway, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "ID do app da Meta não configurado") {
		t.Fatalf("body = %s, want configuration error", rec.Body.String())
	}
}

func TestGivenInvalidEnvAppIDAndNoRequestAppID_WhenUploading_ThenRejectsBeforeCallingMeta(t *testing.T) {
	// Given
	cfg = Config{AppID: "abc"}
	body := `{"mimeType":"image/png","dataBase64":"aGVsbG8="}`

	// When
	rec := postMediaUpload(t, body)

	// Then
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d (body %s)", rec.Code, http.StatusBadRequest, rec.Body.String())
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

const uploadTestToken = "EAAG-token-secreto-de-teste"

func useUploadTransport(t *testing.T, rt roundTripFunc) {
	t.Helper()
	original := mediaUploadClient
	mediaUploadClient = &http.Client{Transport: rt}
	t.Cleanup(func() { mediaUploadClient = original })
}

func TestGivenUploadSession_WhenStarting_ThenTokenTravelsInHeaderNeverInURL(t *testing.T) {
	// Given
	cfg = Config{APIVersion: "v21.0"}
	var captured *http.Request
	useUploadTransport(t, func(r *http.Request) (*http.Response, error) {
		captured = r
		return &http.Response{
			StatusCode: http.StatusOK,
			Body:       io.NopCloser(strings.NewReader(`{"id":"upload:XYZ"}`)),
			Header:     make(http.Header),
		}, nil
	})

	// When
	id, err := startUploadSession(metaIdentity{AccessToken: uploadTestToken}, "123456789", 5, "image/png", "amostra & cia.png")

	// Then
	if err != nil {
		t.Fatalf("startUploadSession error = %v", err)
	}
	if id != "upload:XYZ" {
		t.Fatalf("id = %q, want upload:XYZ", id)
	}
	if strings.Contains(captured.URL.String(), uploadTestToken) {
		t.Fatalf("token leaked into URL: %s", captured.URL.String())
	}
	if captured.URL.Query().Has("access_token") {
		t.Fatalf("access_token still present in query: %s", captured.URL.RawQuery)
	}
	if got := captured.Header.Get("Authorization"); got != "OAuth "+uploadTestToken {
		t.Fatalf("Authorization = %q, want OAuth scheme with the sender token", got)
	}
	if got := captured.URL.Query().Get("file_name"); got != "amostra & cia.png" {
		t.Fatalf("file_name = %q, want the escaped filename round-tripped", got)
	}
}

func TestGivenNetworkFailure_WhenStartingUploadSession_ThenErrorDoesNotExposeToken(t *testing.T) {
	// Given: *url.Error carries the full request URL, and this error is returned to the caller
	cfg = Config{APIVersion: "v21.0"}
	useUploadTransport(t, func(r *http.Request) (*http.Response, error) {
		return nil, errors.New("connection reset")
	})

	// When
	_, err := startUploadSession(metaIdentity{AccessToken: uploadTestToken}, "123456789", 5, "image/png", "amostra.png")

	// Then
	if err == nil {
		t.Fatal("expected an error from the failing transport")
	}
	if strings.Contains(err.Error(), uploadTestToken) {
		t.Fatalf("error message exposes the token: %s", err.Error())
	}
}
