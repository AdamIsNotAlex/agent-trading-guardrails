package guardrail.rules.escalation

import rego.v1

import data.guardrail.rules.allowlist

escalation_reasons contains {"rule": "reviewer_not_approved", "message": "Reviewer did not approve this action."} if {
	input.reviewerVerdict != "approve"
}

escalation_reasons contains {"rule": "reviewer_risk_not_low", "message": "Reviewer risk level is not eligible for automatic execution."} if {
	not input.reviewerRiskLevel == "low"
}

escalation_reasons contains {"rule": "notional_above_auto_threshold", "message": "Notional exceeds automatic execution threshold."} if {
	input.maxNotionalUsd
	limits := data.policy.limits[input.environment]
	limits.auto_max_notional_usd
	input.maxNotionalUsd > limits.auto_max_notional_usd
}

escalation_reasons contains {"rule": "daily_notional_above_threshold", "message": "Daily notional exceeds automatic execution threshold."} if {
	input.dailyNotionalUsd
	limits := data.policy.limits[input.environment]
	limits.auto_max_daily_notional_usd
	input.dailyNotionalUsd > limits.auto_max_daily_notional_usd
}

escalation_reasons contains {"rule": "daily_loss_above_threshold", "message": "Daily loss exceeds automatic execution threshold."} if {
	input.dailyRealizedLossUsd
	limits := data.policy.limits[input.environment]
	limits.auto_max_daily_loss_usd
	input.dailyRealizedLossUsd > limits.auto_max_daily_loss_usd
}

escalation_reasons contains {"rule": "futures_leverage_escalation", "message": "USD-M futures leverage above default cap requires human approval."} if {
	input.accountMode == "usdm_futures"
	input.leverage
	limits := data.policy.limits[input.environment]
	limits.default_max_leverage
	input.leverage > limits.default_max_leverage
	input.leverage <= limits.max_leverage
}

escalation_reasons contains {"rule": "no_matching_allowlist", "message": "No matching allowlist entry found for this principal/action/resource."} if {
	count(data.guardrail.rules.allowlist.allow_reasons) == 0
}

escalation_reasons contains {"rule": "requires_human_by_policy", "message": "Matching allowlist entry requires human approval."} if {
	some entry in data.policy.allowlists.rules
	entry.effect == "allow"
	entry.condition
	entry.condition.requiresHumanApproval == true
	allowlist.principal_matches(entry, input)
	allowlist.action_matches(entry, input)
	allowlist.resource_matches(entry, input)
	escalation_condition_matches(entry, input)
}

escalation_condition_matches(entry, inp) if {
	allowlist.environment_ok(entry, inp)
	allowlist.account_mode_ok(entry, inp)
	allowlist.notional_ok(entry, inp)
	allowlist.leverage_ok(entry, inp)
}
