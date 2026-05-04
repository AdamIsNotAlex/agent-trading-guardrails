package guardrail_test

import rego.v1

import data.guardrail

base_input := {
	"intentId": "550e8400-e29b-41d4-a716-446655440001",
	"principal": "agent.openclaw.strategy-alpha",
	"action": "cex.place_order",
	"resource": "cex:binance:subaccount-1:ETH-USDC",
	"environment": "canary_live",
	"accountMode": "spot",
	"exchange": "binance",
	"symbol": "ETH-USDC",
	"maxNotionalUsd": 8,
	"reviewerVerdict": "approve",
	"reviewerRiskLevel": "low",
}

# Auto-allow: reviewer approved, low notional, matching allowlist
test_auto_allow if {
	guardrail.decision == "allow" with input as base_input
}

test_auto_allow_no_human_approval if {
	guardrail.requires_human_approval == false with input as base_input
}

# No matching allowlist for unknown action → needs_human (not allow)
test_no_allowlist_unknown_action if {
	inp := object.union(base_input, {"action": "cex.unknown_action"})
	guardrail.decision == "needs_human" with input as inp
}

# Missing notional on capped rule → no allowlist match → needs_human
test_missing_notional_fails_closed if {
	inp := object.remove(base_input, ["maxNotionalUsd"])
	guardrail.decision == "needs_human" with input as inp
}

# Reviewer not approved → needs_human
test_needs_human_reviewer_not_approved if {
	inp := object.union(base_input, {"reviewerVerdict": "needs_human"})
	guardrail.decision == "needs_human" with input as inp
}

# Notional above auto threshold → needs_human
test_needs_human_notional_above_threshold if {
	inp := object.union(base_input, {"maxNotionalUsd": 20})
	guardrail.decision == "needs_human" with input as inp
}

# Hard deny: withdrawal
test_hard_deny_withdrawal if {
	inp := object.union(base_input, {"action": "cex.withdraw"})
	guardrail.decision == "deny" with input as inp
}

# Hard deny: account transfer
test_hard_deny_account_transfer if {
	inp := object.union(base_input, {"action": "cex.account_transfer"})
	guardrail.decision == "deny" with input as inp
}

# Hard deny: spot margin
test_hard_deny_spot_margin if {
	inp := object.union(base_input, {"accountMode": "margin"})
	guardrail.decision == "deny" with input as inp
}

# Hard deny: cross margin
test_hard_deny_cross_margin if {
	inp := object.union(base_input, {"accountMode": "cross_margin"})
	guardrail.decision == "deny" with input as inp
}

# Hard deny: COIN-M futures
test_hard_deny_coinm_futures if {
	inp := object.union(base_input, {"accountMode": "coinm_futures"})
	guardrail.decision == "deny" with input as inp
}

# Hard deny: leverage above cap
test_hard_deny_leverage_cap if {
	inp := object.union(base_input, {
		"accountMode": "usdm_futures",
		"leverage": 10,
	})
	guardrail.decision == "deny" with input as inp
}

# Hard deny: unlimited token approval
test_hard_deny_unlimited_approval if {
	inp := object.union(base_input, {
		"action": "onchain.request_signature",
		"chain": "ethereum",
		"resource": "onchain:ethereum:sepolia:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
		"maxTokenApprovalAmount": "unlimited",
	})
	guardrail.decision == "deny" with input as inp
}

# Hard deny: unknown ethereum contract
test_hard_deny_unknown_contract if {
	inp := object.union(base_input, {
		"action": "onchain.request_signature",
		"chain": "ethereum",
		"resource": "onchain:ethereum:sepolia:0xUNKNOWN",
	})
	guardrail.decision == "deny" with input as inp
}

# Hard deny: unknown solana program
test_hard_deny_unknown_program if {
	inp := object.union(base_input, {
		"action": "onchain.request_signature",
		"chain": "solana",
		"resource": "onchain:solana:devnet:UnknownProgram111111111111111111",
	})
	guardrail.decision == "deny" with input as inp
}

# Hard deny: Solana authority change
test_hard_deny_solana_authority_change if {
	inp := object.union(base_input, {
		"action": "onchain.request_signature",
		"chain": "solana",
		"resource": "onchain:solana:devnet:TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
		"instructionType": "authority_change",
	})
	guardrail.decision == "deny" with input as inp
}

# Hard deny wins over human approval: withdrawal even with reviewer approve
test_hard_deny_wins_over_approval if {
	inp := object.union(base_input, {
		"action": "cex.withdraw",
		"reviewerVerdict": "approve",
	})
	guardrail.decision == "deny" with input as inp
	guardrail.requires_human_approval == false with input as inp
}

# Reviewer approval alone is insufficient without matching allowlist
test_reviewer_alone_insufficient if {
	inp := object.union(base_input, {
		"action": "cex.place_order",
		"resource": "cex:unknown_exchange:account:SYM",
		"reviewerVerdict": "approve",
	})
	guardrail.decision != "allow" with input as inp
}

# Futures leverage escalation (above default but below cap)
test_futures_leverage_escalation if {
	inp := object.union(base_input, {
		"accountMode": "usdm_futures",
		"leverage": 2,
		"maxNotionalUsd": 5,
	})
	guardrail.decision == "needs_human" with input as inp
}

# Dev environment auto-allows all actions
test_dev_environment_allows_all if {
	inp := object.union(base_input, {"environment": "dev"})
	guardrail.decision == "allow" with input as inp
}

# Paper environment auto-allows all actions
test_paper_environment_allows_all if {
	inp := object.union(base_input, {"environment": "paper"})
	guardrail.decision == "allow" with input as inp
}

# Testnet environment auto-allows all actions
test_testnet_environment_allows_all if {
	inp := object.union(base_input, {"environment": "testnet"})
	guardrail.decision == "allow" with input as inp
}

# Ethereum Sepolia signing of known contract is allowed
test_ethereum_sepolia_sign_known_contract if {
	inp := {
		"intentId": "test-id",
		"principal": "agent.openclaw.strategy-alpha",
		"action": "onchain.request_signature",
		"resource": "onchain:ethereum:sepolia:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
		"environment": "testnet",
		"chain": "ethereum",
		"reviewerVerdict": "approve",
		"reviewerRiskLevel": "low",
	}
	guardrail.decision == "allow" with input as inp
}

# Solana devnet signing of known program is allowed
test_solana_devnet_sign_known_program if {
	inp := {
		"intentId": "test-id",
		"principal": "agent.hermes.strategy-beta",
		"action": "onchain.request_signature",
		"resource": "onchain:solana:devnet:TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
		"environment": "testnet",
		"chain": "solana",
		"reviewerVerdict": "approve",
		"reviewerRiskLevel": "low",
	}
	guardrail.decision == "allow" with input as inp
}

# Daily notional escalation
test_daily_notional_escalation if {
	inp := object.union(base_input, {"dailyNotionalUsd": 100})
	guardrail.decision == "needs_human" with input as inp
	count(guardrail.escalation_reasons) == 1 with input as inp
	some reason in guardrail.escalation_reasons with input as inp
	reason.rule == "daily_notional_above_threshold"
}

# Daily loss escalation
test_daily_loss_escalation if {
	inp := object.union(base_input, {"dailyRealizedLossUsd": 50})
	guardrail.decision == "needs_human" with input as inp
	count(guardrail.escalation_reasons) == 1 with input as inp
	some reason in guardrail.escalation_reasons with input as inp
	reason.rule == "daily_loss_above_threshold"
}

# Cancel order is allowed
test_cancel_order_allowed if {
	inp := object.union(base_input, {
		"action": "cex.cancel_order",
		"resource": "cex:binance:subaccount-1:ETH-USDC",
	})
	guardrail.decision == "allow" with input as inp
}

test_human_approval_rule_for_other_agent_does_not_escalate if {
	rules := array.concat(data.policy.allowlists.rules, [{
		"name": "agent-specific-human-approval",
		"effect": "allow",
		"principal": "agent.other.strategy",
		"action": "cex.place_order",
		"resource": "cex:binance:",
		"condition": {"requiresHumanApproval": true},
	}])
	guardrail.decision == "allow" with input as base_input with data.policy.allowlists.rules as rules
	guardrail.requires_human_approval == false with input as base_input with data.policy.allowlists.rules as rules
}

test_human_approval_rule_for_other_action_does_not_escalate if {
	rules := array.concat(data.policy.allowlists.rules, [{
		"name": "place-order-human-approval",
		"effect": "allow",
		"principal": "*",
		"action": "cex.place_order",
		"resource": "cex:binance:",
		"condition": {"requiresHumanApproval": true},
	}])
	inp := object.union(base_input, {
		"action": "cex.cancel_order",
		"resource": "cex:binance:subaccount-1:ETH-USDC",
	})
	guardrail.decision == "allow" with input as inp with data.policy.allowlists.rules as rules
	guardrail.requires_human_approval == false with input as inp with data.policy.allowlists.rules as rules
}

test_human_approval_rule_for_other_resource_does_not_escalate if {
	rules := array.concat(data.policy.allowlists.rules, [{
		"name": "other-resource-human-approval",
		"effect": "allow",
		"principal": "*",
		"action": "cex.place_order",
		"resource": "cex:coinbase:",
		"condition": {"requiresHumanApproval": true},
	}])
	guardrail.decision == "allow" with input as base_input with data.policy.allowlists.rules as rules
	guardrail.requires_human_approval == false with input as base_input with data.policy.allowlists.rules as rules
}

test_matching_human_approval_rule_escalates if {
	rules := array.concat(data.policy.allowlists.rules, [{
		"name": "matching-human-approval",
		"effect": "allow",
		"principal": "agent.openclaw.strategy-alpha",
		"action": "cex.place_order",
		"resource": "cex:binance:",
		"condition": {"requiresHumanApproval": true},
	}])
	guardrail.decision == "needs_human" with input as base_input with data.policy.allowlists.rules as rules
	guardrail.requires_human_approval with input as base_input with data.policy.allowlists.rules as rules
	some reason in guardrail.escalation_reasons with input as base_input with data.policy.allowlists.rules as rules
	reason.rule == "requires_human_by_policy"
}

# Futures order above futures limit (5) but below spot limit (10) is escalated
test_futures_above_futures_limit_escalated if {
	inp := object.union(base_input, {
		"accountMode": "usdm_futures",
		"maxNotionalUsd": 8,
		"leverage": 1,
	})
	guardrail.decision == "needs_human" with input as inp
}

# Spot order at 8 (below spot limit 10) is allowed
test_spot_below_spot_limit_allowed if {
	inp := object.union(base_input, {
		"accountMode": "spot",
		"maxNotionalUsd": 8,
	})
	guardrail.decision == "allow" with input as inp
}

# Futures order within futures limit (4 < 5) is allowed
test_futures_within_limit_allowed if {
	inp := object.union(base_input, {
		"accountMode": "usdm_futures",
		"maxNotionalUsd": 4,
		"leverage": 1,
	})
	guardrail.decision == "allow" with input as inp
}
