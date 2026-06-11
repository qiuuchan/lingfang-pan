use uuid::Uuid;

use crate::error::{AppError, AppResult};

#[derive(Debug)]
pub struct PublishDecision {
    pub review_status: Option<&'static str>,
}

pub fn publish_policy(
    existing_author: Option<Uuid>,
    current_tenant: Uuid,
    marketplace: bool,
) -> AppResult<PublishDecision> {
    if existing_author.is_some_and(|author| author != current_tenant) {
        return Err(AppError::BadRequest("插件 ID 已被其他租户使用".to_string()));
    }
    let review_status = if existing_author.is_some() && marketplace {
        Some("pending")
    } else {
        None
    };
    Ok(PublishDecision { review_status })
}

pub struct InstallPolicyInput<'a> {
    current_tenant: Uuid,
    author_tenant: Uuid,
    marketplace: bool,
    review_status: &'a str,
    price_cents: i32,
    purchased: bool,
}

impl<'a> InstallPolicyInput<'a> {
    pub fn new(current_tenant: Uuid, author_tenant: Uuid, review_status: &'a str) -> Self {
        Self {
            current_tenant,
            author_tenant,
            review_status,
            marketplace: false,
            price_cents: 0,
            purchased: false,
        }
    }

    pub fn marketplace(mut self, value: bool) -> Self {
        self.marketplace = value;
        self
    }

    pub fn price_cents(mut self, value: i32) -> Self {
        self.price_cents = value;
        self
    }

    pub fn purchased(mut self, value: bool) -> Self {
        self.purchased = value;
        self
    }
}

pub fn install_policy(input: InstallPolicyInput<'_>) -> AppResult<()> {
    if input.current_tenant == input.author_tenant {
        return Ok(());
    }
    if !input.marketplace || input.review_status != "approved" {
        return Err(AppError::NotFound);
    }
    if input.price_cents > 0 && !input.purchased {
        return Err(AppError::PaymentRequired);
    }
    Ok(())
}
