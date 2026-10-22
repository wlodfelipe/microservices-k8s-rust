//! JWT. O serviço `users` assina, o `gateway` valida. Os serviços internos não veem o token:
//! o gateway repassa só o id do usuário no header `x-user-id` (rede interna do cluster).

use axum::{extract::FromRequestParts, http::request::Parts};
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};

use crate::ApiError;

pub const USER_ID_HEADER: &str = "x-user-id";

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: i64,
    pub username: String,
    pub exp: i64,
}

#[derive(Clone)]
pub struct Jwt {
    enc: EncodingKey,
    dec: DecodingKey,
    ttl_secs: i64,
}

impl Jwt {
    pub fn new(secret: &str) -> Self {
        Self {
            enc: EncodingKey::from_secret(secret.as_bytes()),
            dec: DecodingKey::from_secret(secret.as_bytes()),
            ttl_secs: 60 * 60 * 24 * 7,
        }
    }

    pub fn sign(&self, user_id: i64, username: &str) -> String {
        let exp = time::OffsetDateTime::now_utc().unix_timestamp() + self.ttl_secs;
        let claims = Claims { sub: user_id, username: username.to_string(), exp };
        encode(&Header::default(), &claims, &self.enc).expect("jwt encode")
    }

    pub fn verify(&self, token: &str) -> Result<Claims, ApiError> {
        decode::<Claims>(token, &self.dec, &Validation::new(Algorithm::HS256))
            .map(|d| d.claims)
            .map_err(|_| ApiError::token_invalid())
    }
}

/// Usuário autenticado (obrigatório), lido do header que o gateway injeta.
pub struct AuthUser(pub i64);

/// Usuário opcional: endpoints públicos que mudam a resposta se houver login
/// (`following`, `favorited`).
pub struct Viewer(pub Option<i64>);

fn header_user(parts: &Parts) -> Option<i64> {
    parts.headers.get(USER_ID_HEADER)?.to_str().ok()?.parse().ok()
}

impl<S: Send + Sync> FromRequestParts<S> for AuthUser {
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, Self::Rejection> {
        header_user(parts).map(AuthUser).ok_or_else(ApiError::token_missing)
    }
}

impl<S: Send + Sync> FromRequestParts<S> for Viewer {
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, Self::Rejection> {
        Ok(Viewer(header_user(parts)))
    }
}
