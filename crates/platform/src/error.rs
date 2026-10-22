use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Map, Value};

/// Erro no formato da spec RealWorld: `{"errors": {"campo": ["mensagem"]}}`.
#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub errors: Map<String, Value>,
}

pub type ApiResult<T> = Result<T, ApiError>;

impl ApiError {
    pub fn new(status: StatusCode, field: &str, message: &str) -> Self {
        let mut errors = Map::new();
        errors.insert(field.to_string(), json!([message]));
        Self { status, errors }
    }
    pub fn unprocessable(field: &str, message: &str) -> Self {
        Self::new(StatusCode::UNPROCESSABLE_ENTITY, field, message)
    }
    pub fn blank(field: &str) -> Self {
        Self::unprocessable(field, "can't be blank")
    }
    pub fn not_found(entity: &str) -> Self {
        Self::new(StatusCode::NOT_FOUND, entity, "not found")
    }
    pub fn forbidden(entity: &str) -> Self {
        Self::new(StatusCode::FORBIDDEN, entity, "forbidden")
    }
    pub fn taken(field: &str) -> Self {
        Self::new(StatusCode::CONFLICT, field, "has already been taken")
    }
    pub fn token_missing() -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "token", "is missing")
    }
    pub fn token_invalid() -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "token", "is invalid")
    }
    pub fn unavailable(field: &str) -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, field, "unavailable")
    }
    pub fn internal() -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "server", "internal error")
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "errors": self.errors }))).into_response()
    }
}

#[cfg(feature = "db")]
impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        tracing::error!(error = %e, "erro de banco");
        Self::internal()
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(e: anyhow::Error) -> Self {
        tracing::error!(error = %e, "erro interno");
        Self::internal()
    }
}
