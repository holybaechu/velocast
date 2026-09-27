// Project an already validated release manifest into the private-candidate
// declaration. This is not an acceptance evaluator or a manifest validator.
export function windowsCandidateState(target) {
  if (target.artifact !== null)
    throw new Error("release.windows_public_distribution_requires_separate_workflow");
  const candidate = target.validatedCandidate;
  const validationStatus = candidate === undefined ? "blocked" : "validated";
  if (target.requirements?.validationStatus !== validationStatus)
    throw new Error("release.windows_validation_state_inconsistent");
  if (candidate !== undefined) {
    for (const key of ["sha256", "consumerEvidenceSha256", "hostRequirementsSha256"])
      if (!/^[a-f0-9]{64}$/.test(candidate?.[key] ?? "") || /^0+$/.test(candidate[key]))
        throw new Error(`release.windows_evidence_missing: ${key}`);
  }
  return {
    status: candidate === undefined ? "prepared-not-supported" : "validated-unpublished",
    ...(candidate === undefined ? {} : { validatedCandidate: structuredClone(candidate) }),
    releaseState: {
      artifact: null,
      validationStatus,
      ...(candidate === undefined ? {} : { distributionStatus: "unpublished" }),
      publicDistributionApproved: false,
    },
  };
}
