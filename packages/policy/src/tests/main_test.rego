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

empty_reasons := {reason |
	reason := {"rule": "unused", "message": "unused"}
	false
}

# Auto-allow: reviewer approved, low notional, matching allowlist
test_auto_allow if {
	guardrail.decision == "allow" with input as base_input
}

test_auto_allow_no_human_approval if {
	guardrail.requires_human_approval == false with input as base_input
}

test_auto_allow_exports_allow_reason if {
	some reason in guardrail.reasons with input as base_input
	reason.rule == "binance-spot-low-notional"
	guardrail.matched_allow_rules[_] == "binance-spot-low-notional" with input as base_input
}

# No matching allowlist for unknown action → needs_human (not allow)
test_no_allowlist_unknown_action if {
	inp := object.union(base_input, {"action": "cex.unknown_action"})
	guardrail.decision == "needs_human" with input as inp
}

test_needs_human_exports_escalation_reason if {
	inp := object.union(base_input, {"action": "cex.unknown_action"})
	some reason in guardrail.reasons with input as inp
	reason.rule == "no_matching_allowlist"
}

test_default_deny_exports_default_reason if {
	inp := object.union(base_input, {"resource": "cex:kraken:subaccount-1:ETH-USDC"})
	guardrail.decision == "deny" with input as inp with data.guardrail.rules.escalation.escalation_reasons as empty_reasons
	some reason in guardrail.reasons with input as inp with data.guardrail.rules.escalation.escalation_reasons as empty_reasons
	reason.rule == "default_deny"
	guardrail.matched_deny_rules[_] == "default_deny" with input as inp with data.guardrail.rules.escalation.escalation_reasons as empty_reasons
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

# Reviewer high risk blocks auto-allow
test_needs_human_reviewer_high_risk if {
	inp := object.union(base_input, {"reviewerRiskLevel": "high"})
	guardrail.decision == "needs_human" with input as inp
	some reason in guardrail.escalation_reasons with input as inp
	reason.rule == "reviewer_risk_not_low"
}

# Reviewer medium risk blocks auto-allow
test_needs_human_reviewer_medium_risk if {
	inp := object.union(base_input, {"reviewerRiskLevel": "medium"})
	guardrail.decision == "needs_human" with input as inp
	some reason in guardrail.escalation_reasons with input as inp
	reason.rule == "reviewer_risk_not_low"
}

# Reviewer critical risk blocks auto-allow
test_needs_human_reviewer_critical_risk if {
	inp := object.union(base_input, {"reviewerRiskLevel": "critical"})
	guardrail.decision == "needs_human" with input as inp
	some reason in guardrail.escalation_reasons with input as inp
	reason.rule == "reviewer_risk_not_low"
}

# Missing reviewer risk blocks auto-allow
test_needs_human_reviewer_missing_risk if {
	inp := object.remove(base_input, ["reviewerRiskLevel"])
	guardrail.decision == "needs_human" with input as inp
	some reason in guardrail.escalation_reasons with input as inp
	reason.rule == "reviewer_risk_not_low"
}

# Reviewer low risk allows auto-allow when other conditions match
test_allow_reviewer_low_risk if {
	inp := object.union(base_input, {"reviewerRiskLevel": "low"})
	guardrail.decision == "allow" with input as inp
}

# Hard deny: withdrawal
test_hard_deny_withdrawal if {
	inp := object.union(base_input, {"action": "cex.withdraw"})
	guardrail.decision == "deny" with input as inp
}

test_hard_deny_exports_hard_deny_reason if {
	inp := object.union(base_input, {"action": "cex.withdraw"})
	some reason in guardrail.reasons with input as inp
	reason.rule == "withdrawal_denied"
	guardrail.matched_deny_rules[_] == "withdrawal_denied" with input as inp
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
		"marginType": "isolated",
		"leverage": 10,
	})
	guardrail.decision == "deny" with input as inp
}

# Hard deny: USD-M futures cross margin
test_hard_deny_futures_cross_margin if {
	inp := object.union(base_input, {
		"accountMode": "usdm_futures",
		"marginType": "cross",
		"leverage": 1,
		"maxNotionalUsd": 4,
	})
	guardrail.decision == "deny" with input as inp
	some reason in guardrail.hard_deny_reasons with input as inp
	reason.rule == "futures_cross_margin_denied"
}

# Hard deny: USD-M futures missing margin type
test_hard_deny_futures_missing_margin_type if {
	inp := object.union(base_input, {
		"accountMode": "usdm_futures",
		"leverage": 1,
		"maxNotionalUsd": 4,
	})
	guardrail.decision == "deny" with input as inp
	some reason in guardrail.hard_deny_reasons with input as inp
	reason.rule == "futures_cross_margin_denied"
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

# Hard deny: max uint256 token approval
test_hard_deny_max_uint256_approval if {
	inp := object.union(base_input, {
		"action": "onchain.request_signature",
		"chain": "ethereum",
		"resource": "onchain:ethereum:sepolia:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
		"isTokenApproval": true,
		"tokenApprovalAmountMissing": false,
		"tokenApprovalUnlimited": true,
		"tokenApprovalAmountExceedsCap": false,
	})
	guardrail.decision == "deny" with input as inp
	some reason in guardrail.hard_deny_reasons with input as inp
	reason.rule == "unlimited_approval_denied"
}

# Hard deny: explicit max uint256 metadata without approval calldata
test_hard_deny_explicit_max_uint256_metadata if {
	inp := object.union(base_input, {
		"action": "onchain.request_signature",
		"chain": "ethereum",
		"resource": "onchain:ethereum:sepolia:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
		"maxTokenApprovalAmount": "115792089237316195423570985008687907853269984665640564039457584007913129639935",
	})
	guardrail.decision == "deny" with input as inp
	some reason in guardrail.hard_deny_reasons with input as inp
	reason.rule == "unlimited_approval_denied"
}

# Hard deny: approval policy facts missing
test_hard_deny_approval_facts_missing if {
	inp := object.union(base_input, {
		"action": "onchain.request_signature",
		"chain": "ethereum",
		"resource": "onchain:ethereum:sepolia:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
		"isTokenApproval": true,
	})
	guardrail.decision == "deny" with input as inp
	some reason in guardrail.hard_deny_reasons with input as inp
	reason.rule == "token_approval_facts_missing"
}

# Hard deny: approval calldata missing explicit amount metadata
test_hard_deny_approval_amount_missing if {
	inp := object.union(base_input, {
		"action": "onchain.request_signature",
		"chain": "ethereum",
		"resource": "onchain:ethereum:sepolia:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
		"isTokenApproval": true,
		"tokenApprovalAmountMissing": true,
	})
	guardrail.decision == "deny" with input as inp
	some reason in guardrail.hard_deny_reasons with input as inp
	reason.rule == "token_approval_amount_missing"
}

# Hard deny: approval amount above configured cap
test_hard_deny_approval_amount_above_cap if {
	inp := object.union(base_input, {
		"action": "onchain.request_signature",
		"chain": "ethereum",
		"resource": "onchain:ethereum:sepolia:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
		"isTokenApproval": true,
		"tokenApprovalAmountMissing": false,
		"tokenApprovalUnlimited": false,
		"tokenApprovalAmountExceedsCap": true,
	})
	guardrail.decision == "deny" with input as inp
	some reason in guardrail.hard_deny_reasons with input as inp
	reason.rule == "token_approval_cap_exceeded"
}

# Hard deny: approval amount fact missing despite complete booleans
test_hard_deny_approval_amount_invalid_when_missing if {
	inp := object.union(base_input, {
		"action": "onchain.request_signature",
		"chain": "ethereum",
		"resource": "onchain:ethereum:sepolia:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
		"isTokenApproval": true,
		"tokenApprovalAmountMissing": false,
		"tokenApprovalUnlimited": false,
		"tokenApprovalAmountExceedsCap": false,
	})
	guardrail.decision == "deny" with input as inp
	some reason in guardrail.hard_deny_reasons with input as inp
	reason.rule == "token_approval_amount_invalid"
}

# Hard deny: approval amount fact is not decimal
test_hard_deny_approval_amount_invalid_when_non_decimal if {
	inp := object.union(base_input, {
		"action": "onchain.request_signature",
		"chain": "ethereum",
		"resource": "onchain:ethereum:sepolia:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
		"isTokenApproval": true,
		"tokenApprovalAmount": "not-a-number",
		"tokenApprovalAmountMissing": false,
		"tokenApprovalUnlimited": false,
		"tokenApprovalAmountExceedsCap": false,
	})
	guardrail.decision == "deny" with input as inp
	some reason in guardrail.hard_deny_reasons with input as inp
	reason.rule == "token_approval_amount_invalid"
}

# Hard deny: approval metadata amount is missing
test_hard_deny_approval_metadata_invalid_when_missing if {
	inp := object.union(base_input, {
		"action": "onchain.request_signature",
		"chain": "ethereum",
		"resource": "onchain:ethereum:sepolia:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
		"isTokenApproval": true,
		"tokenApprovalAmount": "100",
		"tokenApprovalAmountMissing": false,
		"tokenApprovalUnlimited": false,
		"tokenApprovalAmountExceedsCap": false,
	})
	guardrail.decision == "deny" with input as inp
	some reason in guardrail.hard_deny_reasons with input as inp
	reason.rule == "token_approval_metadata_invalid"
}

# Hard deny: approval metadata amount is not decimal
test_hard_deny_approval_metadata_invalid_when_non_decimal if {
	inp := object.union(base_input, {
		"action": "onchain.request_signature",
		"chain": "ethereum",
		"resource": "onchain:ethereum:sepolia:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
		"isTokenApproval": true,
		"maxTokenApprovalAmount": "not-a-number",
		"tokenApprovalAmount": "100",
		"tokenApprovalAmountMissing": false,
		"tokenApprovalUnlimited": false,
		"tokenApprovalAmountExceedsCap": false,
	})
	guardrail.decision == "deny" with input as inp
	some reason in guardrail.hard_deny_reasons with input as inp
	reason.rule == "token_approval_metadata_invalid"
}

# Hard deny: approval amount exceeds requested metadata
test_hard_deny_approval_amount_above_metadata if {
	inp := object.union(base_input, {
		"action": "onchain.request_signature",
		"chain": "ethereum",
		"resource": "onchain:ethereum:sepolia:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
		"isTokenApproval": true,
		"maxTokenApprovalAmount": "100",
		"tokenApprovalAmount": "101",
		"tokenApprovalAmountMissing": false,
		"tokenApprovalUnlimited": false,
		"tokenApprovalAmountExceedsCap": false,
	})
	guardrail.decision == "deny" with input as inp
	some reason in guardrail.hard_deny_reasons with input as inp
	reason.rule == "token_approval_amount_exceeds_metadata"
}

# Hard deny: approval amount above configured policy data cap
test_hard_deny_approval_amount_above_policy_data_cap if {
	inp := object.union(base_input, {
		"action": "onchain.request_signature",
		"chain": "ethereum",
		"resource": "onchain:ethereum:sepolia:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
		"environment": "testnet",
		"isTokenApproval": true,
		"tokenApprovalAmount": "1000000000001",
		"tokenApprovalAmountMissing": false,
		"tokenApprovalUnlimited": false,
		"tokenApprovalAmountExceedsCap": false,
	})
	guardrail.decision == "deny" with input as inp
	some reason in guardrail.hard_deny_reasons with input as inp
	reason.rule == "token_approval_cap_exceeded"
}

# Finite approval inside cap is not hard-denied solely by approval rules
test_finite_approval_within_cap_not_hard_denied_by_approval_rule if {
	inp := object.union(base_input, {
		"action": "onchain.request_signature",
		"chain": "ethereum",
		"chainEnvironment": "sepolia",
		"resource": "onchain:ethereum:sepolia:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
		"contractAddress": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
		"isTokenApproval": true,
		"maxTokenApprovalAmount": "100",
		"tokenApprovalAmount": "100",
		"tokenApprovalAmountMissing": false,
		"tokenApprovalUnlimited": false,
		"tokenApprovalAmountExceedsCap": false,
	})
	guardrail.decision == "allow" with input as inp
}

# Hard deny: mainnet onchain signing
test_hard_deny_mainnet_onchain_signing if {
	inp := object.union(base_input, {
		"action": "onchain.request_signature",
		"chain": "ethereum",
		"resource": "onchain:ethereum:mainnet:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
		"chainEnvironment": "mainnet",
		"contractAddress": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
		"environment": "testnet",
	})
	guardrail.decision == "deny" with input as inp
	some reason in guardrail.hard_deny_reasons with input as inp
	reason.rule == "mainnet_onchain_denied"
}

# Hard deny: invalid ethereum/devnet pair
test_hard_deny_ethereum_devnet_pair if {
	inp := object.union(base_input, {
		"action": "onchain.request_signature",
		"chain": "ethereum",
		"chainEnvironment": "devnet",
		"resource": "onchain:ethereum:devnet:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
		"contractAddress": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
	})
	guardrail.decision == "deny" with input as inp
	some reason in guardrail.hard_deny_reasons with input as inp
	reason.rule == "unsupported_chain_environment_pair"
}

# Hard deny: invalid solana/sepolia pair
test_hard_deny_solana_sepolia_pair if {
	inp := object.union(base_input, {
		"action": "onchain.request_signature",
		"chain": "solana",
		"chainEnvironment": "sepolia",
		"resource": "onchain:solana:sepolia:TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
		"programId": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
		"instructionType": "transfer",
	})
	guardrail.decision == "deny" with input as inp
	some reason in guardrail.hard_deny_reasons with input as inp
	reason.rule == "unsupported_chain_environment_pair"
}

# Hard deny: unsupported ethereum environment value
test_hard_deny_ethereum_unsupported_environment if {
	inp := object.union(base_input, {
		"action": "onchain.request_signature",
		"chain": "ethereum",
		"chainEnvironment": "goerli",
		"resource": "onchain:ethereum:goerli:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
		"contractAddress": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
	})
	guardrail.decision == "deny" with input as inp
	some reason in guardrail.hard_deny_reasons with input as inp
	reason.rule == "unsupported_chain_environment_pair"
}

# Hard deny: unsupported solana environment value
test_hard_deny_solana_unsupported_environment if {
	inp := object.union(base_input, {
		"action": "onchain.request_signature",
		"chain": "solana",
		"chainEnvironment": "testnet",
		"resource": "onchain:solana:testnet:TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
		"programId": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
		"instructionType": "transfer",
	})
	guardrail.decision == "deny" with input as inp
	some reason in guardrail.hard_deny_reasons with input as inp
	reason.rule == "unsupported_chain_environment_pair"
}

# Hard deny: missing onchain chain
test_hard_deny_missing_onchain_chain if {
	inp := object.union(base_input, {
		"action": "onchain.request_signature",
		"chainEnvironment": "sepolia",
		"resource": "onchain:ethereum:sepolia:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
		"contractAddress": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
	})
	guardrail.decision == "deny" with input as inp
	some reason in guardrail.hard_deny_reasons with input as inp
	reason.rule == "unsupported_chain_environment_pair"
}

# Hard deny: missing onchain chain environment
test_hard_deny_missing_onchain_chain_environment if {
	inp := object.union(base_input, {
		"action": "onchain.request_signature",
		"chain": "ethereum",
		"resource": "onchain:ethereum:sepolia:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
		"contractAddress": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
	})
	guardrail.decision == "deny" with input as inp
	some reason in guardrail.hard_deny_reasons with input as inp
	reason.rule == "unsupported_chain_environment_pair"
}

# Hard deny: unknown onchain chain value
test_hard_deny_unknown_onchain_chain if {
	inp := object.union(base_input, {
		"action": "onchain.request_signature",
		"chain": "polygon",
		"chainEnvironment": "mainnet",
		"resource": "onchain:polygon:mainnet:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
		"contractAddress": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
	})
	guardrail.decision == "deny" with input as inp
	some reason in guardrail.hard_deny_reasons with input as inp
	reason.rule == "unsupported_chain_environment_pair"
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
		"instructionType": "setAuthority",
	})
	guardrail.decision == "deny" with input as inp
	some reason in guardrail.hard_deny_reasons with input as inp
	reason.rule == "solana_authority_change_denied"
}

# Hard deny: service-classified raw Solana instruction data
_test_hard_deny_solana_raw_instruction_type_input := object.union(base_input, {
	"action": "onchain.request_signature",
	"chain": "solana",
	"chainEnvironment": "devnet",
	"resource": "onchain:solana:devnet:TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
	"programId": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
	"instructionType": "unknown",
})

test_hard_deny_solana_raw_instruction_type if {
	guardrail.decision == "deny" with input as _test_hard_deny_solana_raw_instruction_type_input
	some reason in guardrail.hard_deny_reasons with input as _test_hard_deny_solana_raw_instruction_type_input
	reason.rule == "solana_instruction_type_unknown"
}

# Hard deny: missing Solana instruction type
_test_hard_deny_solana_missing_instruction_type_input := object.union(base_input, {
	"action": "onchain.request_signature",
	"chain": "solana",
	"resource": "onchain:solana:devnet:TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
})

test_hard_deny_solana_missing_instruction_type if {
	guardrail.decision == "deny" with input as _test_hard_deny_solana_missing_instruction_type_input
	some reason in guardrail.hard_deny_reasons with input as _test_hard_deny_solana_missing_instruction_type_input
	reason.rule == "solana_instruction_type_unknown"
}

# Hard deny: unsupported Solana instruction type
test_hard_deny_solana_unsupported_instruction_type if {
	inp := object.union(_test_hard_deny_solana_missing_instruction_type_input, {"instructionType": "closeAccount"})
	guardrail.decision == "deny" with input as inp
	some reason in guardrail.hard_deny_reasons with input as inp
	reason.rule == "solana_instruction_type_unknown"
}

# Hard deny: empty Solana instruction type
test_hard_deny_solana_empty_instruction_type if {
	inp := object.union(_test_hard_deny_solana_missing_instruction_type_input, {"instructionType": ""})
	guardrail.decision == "deny" with input as inp
	some reason in guardrail.hard_deny_reasons with input as inp
	reason.rule == "solana_instruction_type_unknown"
}

# Hard deny: unknown Solana instruction type
test_hard_deny_solana_unknown_instruction_type if {
	inp := object.union(_test_hard_deny_solana_missing_instruction_type_input, {"instructionType": "unknown"})
	guardrail.decision == "deny" with input as inp
	some reason in guardrail.hard_deny_reasons with input as inp
	reason.rule == "solana_instruction_type_unknown"
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
		"marginType": "isolated",
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
		"chainEnvironment": "sepolia",
		"contractAddress": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
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
		"chainEnvironment": "devnet",
		"programId": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
		"instructionType": "transfer",
		"reviewerVerdict": "approve",
		"reviewerRiskLevel": "low",
	}
	guardrail.decision == "allow" with input as inp
}

# Daily notional escalation
test_daily_notional_escalation if {
	inp := object.union(base_input, {"projectedDailyNotionalUsd": 100})
	guardrail.decision == "needs_human" with input as inp
	count(guardrail.escalation_reasons) == 1 with input as inp
	some reason in guardrail.escalation_reasons with input as inp
	reason.rule == "daily_notional_above_threshold"
}

# Futures daily notional uses tighter futures threshold
test_futures_daily_notional_escalation if {
	inp := object.union(base_input, {
		"accountMode": "usdm_futures",
		"marginType": "isolated",
		"maxNotionalUsd": 4,
		"leverage": 1,
		"projectedDailyNotionalUsd": 30,
	})
	guardrail.decision == "needs_human" with input as inp
	count(guardrail.escalation_reasons) == 1 with input as inp
	some reason in guardrail.escalation_reasons with input as inp
	reason.rule == "daily_notional_above_threshold"
}

# Futures daily notional falls back to generic threshold when no futures threshold is configured
test_futures_daily_notional_falls_back_to_generic_threshold if {
	inp := object.union(base_input, {
		"accountMode": "usdm_futures",
		"marginType": "isolated",
		"maxNotionalUsd": 4,
		"leverage": 1,
		"projectedDailyNotionalUsd": 60,
	})
	limits := object.remove(data.policy.limits.canary_live, ["futures_auto_max_daily_notional_usd"])
	guardrail.decision == "needs_human" with input as inp with data.policy.limits.canary_live as limits
	some reason in guardrail.escalation_reasons with input as inp with data.policy.limits.canary_live as limits
	reason.rule == "daily_notional_above_threshold"
}

# Spot daily notional above futures threshold remains allowed
test_spot_daily_notional_uses_spot_threshold if {
	inp := object.union(base_input, {"projectedDailyNotionalUsd": 30})
	guardrail.decision == "allow" with input as inp
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

# Order status query is allowed
test_order_status_allowed if {
	inp := object.union(base_input, {
		"action": "cex.get_order_status",
		"resource": "cex:binance:subaccount-1:ETH-USDC",
	})
	guardrail.decision == "allow" with input as inp
}

# Order status query ignores daily trading thresholds
test_order_status_ignores_daily_thresholds if {
	inp := object.union(base_input, {
		"action": "cex.get_order_status",
		"resource": "cex:binance:subaccount-1:ETH-USDC",
		"projectedDailyNotionalUsd": 100,
		"dailyRealizedLossUsd": 50,
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
		"marginType": "isolated",
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
		"marginType": "isolated",
		"maxNotionalUsd": 4,
		"leverage": 1,
	})
	guardrail.decision == "allow" with input as inp
}
