import { describe, expect, it } from "vitest";
import {
  parseCreateProgramInput,
  parseCreateStreamInput,
  parseCreateTranslatorInput,
  parseEmail,
  parseUpdateProgramInput,
  parseUpdateStreamInput
} from "../src/domain/programs";

describe("program domain validation", () => {
  it("accepts a valid program", () => {
    expect(
      parseCreateProgramInput({
        slug: "patna-event-2026",
        name: "Patna Event 2026",
        venue: "Main Hall",
        eventDate: "2026-08-01",
        adminNotes: "Use backup hotspot"
      })
    ).toEqual({
      slug: "patna-event-2026",
      name: "Patna Event 2026",
      venue: "Main Hall",
      eventDate: "2026-08-01",
      adminNotes: "Use backup hotspot"
    });
  });

  it("rejects an invalid slug", () => {
    expect(() =>
      parseCreateProgramInput({
        slug: "Patna Event",
        name: "Patna Event 2026",
        venue: "Main Hall",
        eventDate: "2026-08-01"
      })
    ).toThrow("slug must use lowercase letters, numbers, and hyphens");
  });

  it("rejects non-object program input", () => {
    expect(() => parseCreateProgramInput(null)).toThrow(
      "program input must be an object"
    );
  });

  it("accepts an optional listener access-control flag on program create and update", () => {
    expect(
      parseCreateProgramInput({
        slug: "patna-event-2026",
        name: "Patna Event 2026",
        venue: "Main Hall",
        eventDate: "2026-08-01",
        accessControlEnabled: true
      })
    ).toMatchObject({ accessControlEnabled: true });
    expect(
      parseUpdateProgramInput({ accessControlEnabled: false })
    ).toEqual({ accessControlEnabled: false });
  });

  it("rejects non-boolean listener access-control flags", () => {
    expect(() =>
      parseCreateProgramInput({
        slug: "patna-event-2026",
        name: "Patna Event 2026",
        venue: "Main Hall",
        eventDate: "2026-08-01",
        accessControlEnabled: 1
      })
    ).toThrow("accessControlEnabled must be a boolean");
    expect(() =>
      parseUpdateProgramInput({ accessControlEnabled: "true" })
    ).toThrow("accessControlEnabled must be a boolean");
  });

  it("accepts a valid language stream", () => {
    expect(
      parseCreateStreamInput({
        languageName: "Hindi",
        languageCode: "hi",
        displayOrder: 1,
        isActive: true
      })
    ).toEqual({
      languageName: "Hindi",
      nativeName: "हिन्दी",
      languageCode: "hi",
      displayOrder: 1,
      isActive: true
    });
  });

  it("defaults omitted stream active state to true", () => {
    expect(
      parseCreateStreamInput({
        languageName: "Hindi",
        languageCode: "hi",
        displayOrder: 1
      })
    ).toEqual({
      languageName: "Hindi",
      nativeName: "हिन्दी",
      languageCode: "hi",
      displayOrder: 1,
      isActive: true
    });
  });

  it("rejects non-object language stream input", () => {
    expect(() => parseCreateStreamInput(null)).toThrow(
      "stream input must be an object"
    );
  });

  it("rejects an invalid display order", () => {
    expect(() =>
      parseCreateStreamInput({
        languageName: "Hindi",
        languageCode: "hi",
        displayOrder: 1.5,
        isActive: true
      })
    ).toThrow("displayOrder must be a non-negative integer");
  });

  it("rejects a language code that is not in the supported set", () => {
    expect(() =>
      parseCreateStreamInput({
        languageName: "Hindi",
        languageCode: "Hindi",
        displayOrder: 1,
        isActive: true
      })
    ).toThrow("languageCode must be a supported language code");

    expect(() =>
      parseCreateStreamInput({
        languageName: "Klingon",
        languageCode: "zz",
        displayOrder: 1,
        isActive: true
      })
    ).toThrow("languageCode must be a supported language code");
  });

  it("derives the canonical language name from the code", () => {
    // A mismatched client-sent name must be overridden by the server.
    expect(
      parseCreateStreamInput({
        languageName: "Not Hindi",
        languageCode: "hi",
        displayOrder: 2,
        isActive: true
      })
    ).toEqual({
      languageName: "Hindi",
      nativeName: "हिन्दी",
      languageCode: "hi",
      displayOrder: 2,
      isActive: true
    });
  });

  it("derives the name on update when a supported code is given", () => {
    expect(parseUpdateStreamInput({ languageCode: "kn" })).toEqual({
      languageCode: "kn",
      languageName: "Kannada",
      nativeName: "ಕನ್ನಡ"
    });
  });

  it("rejects an unsupported code on update", () => {
    expect(() => parseUpdateStreamInput({ languageCode: "zz" })).toThrow(
      "languageCode must be a supported language code"
    );
  });

  it("rejects setting a stream language name without a code", () => {
    expect(() => parseUpdateStreamInput({ languageName: "Hindi" })).toThrow(
      "stream language is set via languageCode"
    );
  });

  it("rejects setting a stream native name without a code", () => {
    expect(() => parseUpdateStreamInput({ nativeName: "हिन्दी" })).toThrow(
      "stream language is set via languageCode"
    );
  });

  it("rejects malformed stream active state", () => {
    expect(() =>
      parseCreateStreamInput({
        languageName: "Hindi",
        languageCode: "hi",
        displayOrder: 1,
        isActive: "false"
      })
    ).toThrow("isActive must be a boolean");
  });
});

describe("translator domain validation", () => {
  it("accepts a translator and normalizes the email (trim + lowercase)", () => {
    expect(
      parseCreateTranslatorInput({
        email: "  Hindi.Translator@Example.COM ",
        name: "Hindi Translator",
        password: "plain-pass"
      })
    ).toEqual({
      email: "hindi.translator@example.com",
      name: "Hindi Translator",
      password: "plain-pass"
    });
  });

  it("rejects a malformed email", () => {
    for (const bad of [
      "not-an-email",
      "a@b",
      "a b@c.com",
      "@x.com",
      "x@.com"
    ]) {
      expect(() =>
        parseCreateTranslatorInput({ email: bad, name: "X", password: "p" })
      ).toThrow("email must be a valid email address");
    }
  });

  it("rejects a missing or non-string email", () => {
    expect(() =>
      parseCreateTranslatorInput({ email: 123, name: "X", password: "p" })
    ).toThrow("email is required");
    expect(() =>
      parseCreateTranslatorInput({ email: "", name: "X", password: "p" })
    ).toThrow("email is required");
  });

  it("exposes parseEmail so the login route shares one normalizer", () => {
    expect(parseEmail("  Foo@Bar.com ")).toBe("foo@bar.com");
    expect(() => parseEmail("nope")).toThrow(
      "email must be a valid email address"
    );
  });
});
