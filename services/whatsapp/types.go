package main

import "encoding/json"

// --- Inbound types (Meta → este serviço) ---

type InboundPayload struct {
	Object string         `json:"object"`
	Entry  []InboundEntry `json:"entry"`
}

type InboundEntry struct {
	ID      string          `json:"id"`
	Changes []InboundChange `json:"changes"`
}

type InboundChange struct {
	Value InboundValue `json:"value"`
	Field string       `json:"field"`
}

type InboundValue struct {
	MessagingProduct string           `json:"messaging_product"`
	Metadata         InboundMetadata  `json:"metadata"`
	Contacts         []InboundContact `json:"contacts"`
	Messages         []InboundMessage `json:"messages"`
	Statuses         []InboundStatus  `json:"statuses"`
}

type InboundMetadata struct {
	DisplayPhoneNumber string `json:"display_phone_number"`
	PhoneNumberID      string `json:"phone_number_id"`
}

type InboundContact struct {
	Profile struct {
		Name string `json:"name"`
	} `json:"profile"`
	WaID string `json:"wa_id"`
}

type MessageContext struct {
	From string `json:"from"`
	ID   string `json:"id"`
}

type InboundMessage struct {
	From        string          `json:"from"`
	ID          string          `json:"id"`
	Timestamp   string          `json:"timestamp"`
	Type        string          `json:"type"`
	Context     *MessageContext `json:"context,omitempty"`
	Text        *TextBody       `json:"text,omitempty"`
	Image       *MediaBody      `json:"image,omitempty"`
	Audio       *MediaBody      `json:"audio,omitempty"`
	Video       *MediaBody      `json:"video,omitempty"`
	Document    *MediaBody      `json:"document,omitempty"`
	Sticker     *MediaBody      `json:"sticker,omitempty"`
	Location    *Location       `json:"location,omitempty"`
	Interactive *Interactive    `json:"interactive,omitempty"`
	Button      *ButtonEvent    `json:"button,omitempty"`
}

type TextBody struct {
	Body string `json:"body"`
}

type MediaBody struct {
	ID       string `json:"id,omitempty"`
	Link     string `json:"link,omitempty"`
	Caption  string `json:"caption,omitempty"`
	Filename string `json:"filename,omitempty"`
	MimeType string `json:"mime_type,omitempty"`
	SHA256   string `json:"sha256,omitempty"`
}

type Location struct {
	Latitude  float64 `json:"latitude"`
	Longitude float64 `json:"longitude"`
	Name      string  `json:"name,omitempty"`
	Address   string  `json:"address,omitempty"`
}

type Interactive struct {
	Type        string       `json:"type"`
	ButtonReply *ButtonReply `json:"button_reply,omitempty"`
	ListReply   *ListReply   `json:"list_reply,omitempty"`
}

type ButtonReply struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

type ListReply struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Description string `json:"description,omitempty"`
}

type ButtonEvent struct {
	Payload string `json:"payload"`
	Text    string `json:"text"`
}

type InboundStatus struct {
	ID          string `json:"id"`
	RecipientID string `json:"recipient_id"`
	Status      string `json:"status"`
	Timestamp   string `json:"timestamp"`
	Errors      []struct {
		Code      int    `json:"code"`
		Title     string `json:"title"`
		Message   string `json:"message,omitempty"`
		ErrorData struct {
			Details string `json:"details,omitempty"`
		} `json:"error_data,omitempty"`
	} `json:"errors,omitempty"`
}

// --- Outbound request types (caller → este serviço) ---

type SendTextRequest struct {
	To          string `json:"to"`
	Message     string `json:"message"`
	ReplyToID   string `json:"reply_to_id,omitempty"`
}

type SendTemplateRequest struct {
	To         string        `json:"to"`
	Template   string        `json:"template"`
	Language   string        `json:"language"`
	Components []interface{} `json:"components,omitempty"`
}

type SendMediaRequest struct {
	To      string `json:"to"`
	Type    string `json:"type"` // image | audio | video | document | sticker
	MediaID string `json:"media_id,omitempty"`
	Link    string `json:"link,omitempty"`
	Caption string `json:"caption,omitempty"`
}

type SendButtonsRequest struct {
	To      string   `json:"to"`
	Body    string   `json:"body"`
	Buttons []Button `json:"buttons"`
}

type Button struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

type SendListRequest struct {
	To         string        `json:"to"`
	Body       string        `json:"body"`
	ButtonText string        `json:"button_text"`
	Sections   []ListSection `json:"sections"`
}

type ListSection struct {
	Title string    `json:"title"`
	Rows  []ListRow `json:"rows"`
}

type ListRow struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Description string `json:"description,omitempty"`
}

type SendReactionRequest struct {
	To        string `json:"to"`
	MessageID string `json:"message_id"`
	Emoji     string `json:"emoji"`
}

type MarkReadRequest struct {
	MessageID string `json:"message_id"`
}

// --- Resposta padrão da API ---

type APIResponse struct {
	Success bool            `json:"success"`
	Error   string          `json:"error,omitempty"`
	Data    json.RawMessage `json:"data,omitempty"`
}
