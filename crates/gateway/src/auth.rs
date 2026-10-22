use axum::{extract::FromRequestParts, http::request::Parts};
use platform::{auth::Claims, ApiError};

use crate::Gw;

/// Login obrigatório. Aceita `Authorization: Token <jwt>` (spec) e `Bearer <jwt>`.
pub struct Auth(pub Claims);

/// Login opcional: muda `following`/`favorited` na resposta.
pub struct MaybeAuth(pub Option<Claims>);

impl Auth {
    pub fn id(&self) -> Option<i64> {
        Some(self.0.sub)
    }
}

impl MaybeAuth {
    pub fn id(&self) -> Option<i64> {
        self.0.as_ref().map(|c| c.sub)
    }
}

fn token(parts: &Parts) -> Option<&str> {
    let h = parts.headers.get("authorization")?.to_str().ok()?;
    h.strip_prefix("Token ").or_else(|| h.strip_prefix("Bearer ")).map(str::trim)
}

impl FromRequestParts<Gw> for Auth {
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut Parts, gw: &Gw) -> Result<Self, Self::Rejection> {
        let t = token(parts).ok_or_else(ApiError::token_missing)?;
        gw.jwt.verify(t).map(Auth)
    }
}

impl FromRequestParts<Gw> for MaybeAuth {
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut Parts, gw: &Gw) -> Result<Self, Self::Rejection> {
        match token(parts) {
            None => Ok(MaybeAuth(None)),
            Some(t) => gw.jwt.verify(t).map(|c| MaybeAuth(Some(c))),
        }
    }
}
