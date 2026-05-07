package guardrail.rules.deny

import rego.v1

hard_deny_reasons contains {"rule": "withdrawal_denied", "message": "CEX withdrawals are not permitted."} if {
	input.action == "cex.withdraw"
}

hard_deny_reasons contains {"rule": "account_transfer_denied", "message": "CEX account transfers are not permitted."} if {
	input.action == "cex.account_transfer"
}

hard_deny_reasons contains {"rule": "spot_margin_denied", "message": "Spot margin and cross-margin are not permitted."} if {
	input.accountMode == "margin"
}

hard_deny_reasons contains {"rule": "spot_margin_denied", "message": "Spot margin and cross-margin are not permitted."} if {
	input.accountMode == "cross_margin"
}

hard_deny_reasons contains {"rule": "coinm_futures_denied", "message": "COIN-M futures trading is not permitted."} if {
	input.accountMode == "coinm_futures"
}

hard_deny_reasons contains {"rule": "leverage_cap_exceeded", "message": "USD-M futures leverage exceeds policy cap."} if {
	input.accountMode == "usdm_futures"
	input.leverage > data.policy.limits[input.environment].max_leverage
}

hard_deny_reasons contains {"rule": "futures_cross_margin_denied", "message": "USD-M futures orders must use isolated margin."} if {
	input.accountMode == "usdm_futures"
	not input.marginType == "isolated"
}

hard_deny_reasons contains {"rule": "unlimited_approval_denied", "message": "Unlimited token approvals are not permitted."} if {
	input.maxTokenApprovalAmount == "unlimited"
}

hard_deny_reasons contains {"rule": "unlimited_approval_denied", "message": "Unlimited token approvals are not permitted."} if {
	input.maxTokenApprovalAmount == "115792089237316195423570985008687907853269984665640564039457584007913129639935"
}

hard_deny_reasons contains {"rule": "unlimited_approval_denied", "message": "Unlimited token approvals are not permitted."} if {
	input.tokenApprovalUnlimited == true
}

hard_deny_reasons contains {"rule": "token_approval_facts_missing", "message": "ERC-20 approval policy facts are incomplete."} if {
	input.isTokenApproval == true
	not approval_facts_complete
}

hard_deny_reasons contains {"rule": "token_approval_amount_missing", "message": "ERC-20 approvals require explicit approval amount metadata."} if {
	input.isTokenApproval == true
	input.tokenApprovalAmountMissing == true
}

hard_deny_reasons contains {"rule": "token_approval_amount_invalid", "message": "ERC-20 approvals require a valid decimal approval amount."} if {
	input.isTokenApproval == true
	amount := object.get(input, "tokenApprovalAmount", null)
	not valid_decimal_string(amount)
}

hard_deny_reasons contains {"rule": "token_approval_cap_exceeded", "message": "ERC-20 approval amount exceeds policy cap."} if {
	input.isTokenApproval == true
	input.tokenApprovalAmountExceedsCap == true
}

hard_deny_reasons contains {"rule": "token_approval_cap_exceeded", "message": "ERC-20 approval amount exceeds policy cap."} if {
	input.isTokenApproval == true
	valid_decimal_string(data.policy.limits[input.environment].max_token_approval_amount)
	decimal_string_exceeds(input.tokenApprovalAmount, data.policy.limits[input.environment].max_token_approval_amount)
}

hard_deny_reasons contains {"rule": "token_approval_amount_exceeds_metadata", "message": "ERC-20 approval amount exceeds requested metadata amount."} if {
	input.isTokenApproval == true
	valid_decimal_string(input.maxTokenApprovalAmount)
	decimal_string_exceeds(input.tokenApprovalAmount, input.maxTokenApprovalAmount)
}

hard_deny_reasons contains {"rule": "unsupported_chain_environment_pair", "message": "Unsupported onchain chain/environment pair."} if {
	input.action in {"onchain.request_signature", "onchain.simulate_transaction"}
	not supported_chain_environment_pair
}

hard_deny_reasons contains {"rule": "mainnet_onchain_denied", "message": "Mainnet onchain signing is not permitted."} if {
	input.action == "onchain.request_signature"
	input.chainEnvironment == "mainnet"
}

hard_deny_reasons contains {"rule": "unknown_contract_denied", "message": "Interaction with unknown contracts is not permitted."} if {
	input.action == "onchain.request_signature"
	input.chain == "ethereum"
	not contract_allowed(input.resource)
}

hard_deny_reasons contains {"rule": "unknown_program_denied", "message": "Interaction with unknown Solana programs is not permitted."} if {
	input.action == "onchain.request_signature"
	input.chain == "solana"
	not program_allowed(input.resource)
}

hard_deny_reasons contains {"rule": "solana_authority_change_denied", "message": "Solana authority changes are not permitted without human approval."} if {
	input.action == "onchain.request_signature"
	input.chain == "solana"
	input.instructionType in {"setAuthority", "SetAuthority", "authority_change"}
}

hard_deny_reasons contains {"rule": "solana_instruction_type_unknown", "message": "Solana instruction type is unavailable or unsupported."} if {
	input.action == "onchain.request_signature"
	input.chain == "solana"
	not supported_solana_instruction_type
}

supported_solana_instruction_type if {
	input.instructionType in {"transfer", "setAuthority", "SetAuthority", "authority_change"}
}

supported_chain_environment_pair if {
	input.chain == "ethereum"
	input.chainEnvironment in {"sepolia", "mainnet"}
}

supported_chain_environment_pair if {
	input.chain == "solana"
	input.chainEnvironment in {"devnet", "mainnet"}
}

approval_facts_complete if {
	input.tokenApprovalAmountMissing in {true, false}
	input.tokenApprovalUnlimited in {true, false}
	input.tokenApprovalAmountExceedsCap in {true, false}
}

valid_decimal_string(value) if {
	is_string(value)
	regex.match("^(0|[1-9][0-9]*)$", value)
}

decimal_string_exceeds(amount, cap) if {
	valid_decimal_string(amount)
	valid_decimal_string(cap)
	count(amount) > count(cap)
}

decimal_string_exceeds(amount, cap) if {
	valid_decimal_string(amount)
	valid_decimal_string(cap)
	count(amount) == count(cap)
	amount > cap
}

contract_allowed(_) if {
	input.contractAddress
	some entry in data.policy.allowlists.ethereum_contracts
	lower(input.contractAddress) == lower(entry)
}

program_allowed(_) if {
	input.programId
	some entry in data.policy.allowlists.solana_programs
	input.programId == entry
}
