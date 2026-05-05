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

contract_allowed(resource) if {
	some entry in data.policy.allowlists.ethereum_contracts
	contains(resource, entry)
}

program_allowed(resource) if {
	some entry in data.policy.allowlists.solana_programs
	contains(resource, entry)
}
