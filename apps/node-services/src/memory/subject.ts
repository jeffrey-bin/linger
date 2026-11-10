export interface MemorySubjectDescriptor {
  agentManagementId: string;
  agentActorId: string;
  agentDisplayName: string;
  representedHumanActorId: string;
  representedHumanDisplayName: string;
  userProfileRevisionId?: string;
  userProfileMarkdown?: string;
}

export function memorySubjectKey(subject: MemorySubjectDescriptor): string {
  return assertSafeMemorySubjectKey(subject.agentManagementId);
}

export function assertSafeMemorySubjectKey(subjectKey: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(subjectKey)) {
    throw new Error(`Unsafe memory subject key: ${subjectKey}`);
  }
  return subjectKey;
}
