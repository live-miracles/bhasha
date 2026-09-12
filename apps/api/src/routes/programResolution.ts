import {
  ProgramNotFoundError,
  ProgramRepository,
  type ProgramRecord
} from "../db/programRepository";

export interface BrowserProgramReference {
  programId?: string;
  programSlug?: string;
}

export interface ResolvedBrowserProgram {
  programId: string;
  programSlug?: string;
  program?: ProgramRecord;
}

export class ProgramReferenceMismatchError extends Error {
  constructor() {
    super("Program slug and id refer to different programs");
  }
}

export async function resolveBrowserProgramReference(
  programs: ProgramRepository,
  reference: BrowserProgramReference
): Promise<ResolvedBrowserProgram> {
  if (reference.programSlug) {
    const program = await programs.getProgramBySlug(reference.programSlug);
    if (!program) {
      throw new ProgramNotFoundError();
    }

    if (reference.programId && reference.programId !== program.id) {
      throw new ProgramReferenceMismatchError();
    }

    return {
      programId: program.id,
      programSlug: program.slug,
      program
    };
  }

  if (reference.programId) {
    const program = await programs.getProgramById(reference.programId);
    if (!program) {
      throw new ProgramNotFoundError();
    }

    return {
      programId: reference.programId,
      program
    };
  }

  throw new ProgramNotFoundError();
}
