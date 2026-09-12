import { beforeEach, describe, expect, it } from "vitest";

import { ProgramRepository } from "../src/db/programRepository";
import { testEnv } from "./test-env";

type SeededProgram = {
  id: string;
  slug: string;
};

async function resetDb(): Promise<void> {
  await testEnv.DB.exec("DELETE FROM listener_realtime_cleanup_targets");
  await testEnv.DB.exec("DELETE FROM realtime_publish_sessions");
  await testEnv.DB.exec("DELETE FROM translator_sessions");
  await testEnv.DB.exec("DELETE FROM stream_events");
  await testEnv.DB.exec("DELETE FROM listener_connections");
  await testEnv.DB.exec("DELETE FROM admin_sessions");
  await testEnv.DB.exec("DELETE FROM translator_stream_assignments");
  await testEnv.DB.exec("DELETE FROM translators");
  await testEnv.DB.exec("DELETE FROM language_streams");
  await testEnv.DB.exec("DELETE FROM programs");
}

async function seedProgram(
  status: "draft" | "live" | "archived"
): Promise<SeededProgram> {
  const id = `program_soft_delete_${crypto.randomUUID()}`;
  const slug = `${status}-${id}`;
  const now = new Date().toISOString();
  await testEnv.DB.prepare(
    `INSERT INTO programs
    (id, slug, name, venue, event_date, status, admin_notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      slug,
      `Program ${slug}`,
      "Main Hall",
      "2026-08-01",
      status,
      "test program notes",
      now,
      now
    )
    .run();

  return { id, slug };
}

describe("program soft-delete repository behavior", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("filters deleted programs by default for list and get operations", async () => {
    const programRepo = new ProgramRepository(testEnv.DB);
    const draft = await seedProgram("draft");
    const live = await seedProgram("live");
    const archived = await seedProgram("archived");

    await programRepo.softDeleteProgram(live.id);
    await programRepo.softDeleteProgram(archived.id);

    const programs = await programRepo.listPrograms();
    const ids = programs.map((program) => program.id);
    expect(ids).toContain(draft.id);
    expect(ids).not.toContain(live.id);
    expect(ids).not.toContain(archived.id);

    expect(await programRepo.getProgramById(live.id)).toBeNull();
    expect(await programRepo.getProgramById(live.id, { includeDeleted: true })).not
      .toBeNull();
  });

  it("restores a soft-deleted program", async () => {
    const programRepo = new ProgramRepository(testEnv.DB);
    const program = await seedProgram("archived");

    await programRepo.softDeleteProgram(program.id);
    expect(await programRepo.getProgramById(program.id)).toBeNull();

    await programRepo.restoreProgram(program.id);
    const restored = await programRepo.getProgramById(program.id);
    expect(restored).not.toBeNull();
    expect(restored?.id).toBe(program.id);
  });

  it("is a no-op when restoring a program that is not soft-deleted", async () => {
    const programRepo = new ProgramRepository(testEnv.DB);
    const program = await seedProgram("archived");

    const before = await programRepo.getProgramById(program.id);
    expect(before).not.toBeNull();
    const updatedAtBefore = before?.updatedAt;

    // Restore must not touch a program that was never soft-deleted: it stays
    // visible, its deleted_at remains null, and updated_at is not bumped.
    await programRepo.restoreProgram(program.id);

    const after = await programRepo.getProgramById(program.id);
    expect(after).not.toBeNull();
    expect(after?.id).toBe(program.id);
    expect(after?.deletedAt ?? null).toBeNull();
    expect(after?.updatedAt).toBe(updatedAtBefore);
  });

  it("throws NotFound when restoring a program that does not exist", async () => {
    const programRepo = new ProgramRepository(testEnv.DB);
    await expect(
      programRepo.restoreProgram("program_does_not_exist")
    ).rejects.toThrow();
  });
});
