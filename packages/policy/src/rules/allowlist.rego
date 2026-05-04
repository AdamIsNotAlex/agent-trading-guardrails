package guardrail.rules.allowlist

import rego.v1

allow_reasons contains {"rule": rule_name, "message": "Matched allowlist entry."} if {
	some entry in data.policy.allowlists.rules
	entry.effect == "allow"
	principal_matches(entry, input)
	action_matches(entry, input)
	resource_matches(entry, input)
	condition_matches(entry, input)
	rule_name := entry.name
}

principal_matches(entry, inp) if {
	entry.principal == "*"
}

principal_matches(entry, inp) if {
	entry.principal == inp.principal
}

action_matches(entry, inp) if {
	entry.action == "*"
}

action_matches(entry, inp) if {
	entry.action == inp.action
}

resource_matches(entry, inp) if {
	entry.resource == "*"
}

resource_matches(entry, inp) if {
	startswith(inp.resource, entry.resource)
}

condition_matches(entry, inp) if {
	not entry.condition
}

condition_matches(entry, inp) if {
	entry.condition
	environment_ok(entry, inp)
	account_mode_ok(entry, inp)
	notional_ok(entry, inp)
	leverage_ok(entry, inp)
	human_approval_ok(entry, inp)
}

environment_ok(entry, inp) if {
	not entry.condition.environment
}

environment_ok(entry, inp) if {
	entry.condition.environment
	inp.environment == entry.condition.environment
}

account_mode_ok(entry, _inp) if {
	not entry.condition.accountMode
}

account_mode_ok(entry, inp) if {
	entry.condition.accountMode
	inp.accountMode == entry.condition.accountMode
}

notional_ok(entry, _inp) if {
	not entry.condition.maxNotionalUsd
}

notional_ok(entry, inp) if {
	entry.condition.maxNotionalUsd
	inp.maxNotionalUsd
	inp.maxNotionalUsd <= entry.condition.maxNotionalUsd
}

leverage_ok(entry, _inp) if {
	not entry.condition.maxLeverage
}

leverage_ok(entry, inp) if {
	entry.condition.maxLeverage
	not inp.leverage
	entry.condition.maxLeverage >= 1
}

leverage_ok(entry, inp) if {
	entry.condition.maxLeverage
	inp.leverage
	inp.leverage <= entry.condition.maxLeverage
}

human_approval_ok(entry, _inp) if {
	not entry.condition.requiresHumanApproval
}

human_approval_ok(entry, _inp) if {
	entry.condition.requiresHumanApproval == false
}
