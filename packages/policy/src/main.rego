package guardrail

import rego.v1

import data.guardrail.rules.allowlist
import data.guardrail.rules.deny
import data.guardrail.rules.escalation

default decision := "deny"

default requires_human_approval := false

decision := "deny" if {
	count(hard_deny_reasons) > 0
}

decision := "needs_human" if {
	count(hard_deny_reasons) == 0
	count(escalation_reasons) > 0
}

decision := "allow" if {
	count(hard_deny_reasons) == 0
	count(escalation_reasons) == 0
	count(allow_reasons) > 0
	reviewer_approved
}

requires_human_approval if {
	decision == "needs_human"
}

hard_deny_reasons contains reason if {
	some reason in deny.hard_deny_reasons
}

escalation_reasons contains reason if {
	some reason in escalation.escalation_reasons
}

allow_reasons contains reason if {
	some reason in allowlist.allow_reasons
}

all_deny_reasons contains reason if {
	some reason in hard_deny_reasons
}

all_deny_reasons contains reason if {
	decision == "deny"
	count(hard_deny_reasons) == 0
	reason := {"rule": "default_deny", "message": "No matching allow rule found."}
}

matched_allow_rules contains rule if {
	some reason in allow_reasons
	rule := reason.rule
}

matched_deny_rules contains rule if {
	some reason in hard_deny_reasons
	rule := reason.rule
}

reviewer_approved if {
	input.reviewerVerdict == "approve"
}

reasons := array.concat(
	[reason | some reason in hard_deny_reasons],
	[reason | some reason in escalation_reasons],
)
