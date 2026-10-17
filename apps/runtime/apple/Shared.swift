import AVFoundation
import Foundation
import FoundationModels
import Speech

/**
 * Apple's models on the device, for the runtime's helper (main.swift, a Mac). The mobile app's
 * module (engenty-wizards-apps, mobile/modules/apple-intelligence) is built from a copy of this
 * file; keep the two the same. The Foundation Models framework answers text, with guided
 * generation for a JSON schema; SpeechAnalyzer writes voice notes down. Both need the 26 systems.
 */

/** One text call: instructions, the prompt, and a JSON schema the answer must match. */
struct Call: Decodable {
  var system: String?
  var prompt: String
  var schema: JSONValue?
  /** `general`, or `tagging` for Apple's adapter for tagging and extraction. */
  var useCase: String?
  var maxTokens: Int?
  var temperature: Double?
}

/** What went wrong, by kind: the runtime and the app read the kind, the person the message. */
struct AppleFailure: Error {
  let kind: String
  let message: String
}

/// JSON as it comes: enough of it to read a JSON schema.
enum JSONValue: Decodable {
  case string(String), number(Double), bool(Bool), null
  case array([JSONValue]), object([String: JSONValue])

  init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if c.decodeNil() { self = .null; return }
    if let b = try? c.decode(Bool.self) { self = .bool(b); return }
    if let n = try? c.decode(Double.self) { self = .number(n); return }
    if let s = try? c.decode(String.self) { self = .string(s); return }
    if let a = try? c.decode([JSONValue].self) { self = .array(a); return }
    self = .object(try c.decode([String: JSONValue].self))
  }

  subscript(key: String) -> JSONValue? {
    if case .object(let o) = self { return o[key] }
    return nil
  }
  var string: String? { if case .string(let s) = self { return s } else { return nil } }
  var strings: [String]? {
    if case .array(let a) = self { return a.compactMap(\.string) } else { return nil }
  }
  var object: [String: JSONValue]? { if case .object(let o) = self { return o } else { return nil } }
  var array: [JSONValue]? { if case .array(let a) = self { return a } else { return nil } }
  var int: Int? { if case .number(let n) = self { return Int(n) } else { return nil } }
  var isNull: Bool { if case .null = self { return true } else { return false } }
}

/// A JSON schema (as the AI SDK writes one from zod) as the model's dynamic schema.
@available(macOS 26.0, iOS 26.0, *)
final class SchemaBuilder {
  private var names = 0
  private var definitions: [String: JSONValue] = [:]
  private(set) var dependencies: [DynamicGenerationSchema] = []
  private var built: Set<String> = []

  init(root: JSONValue) {
    definitions = root["$defs"]?.object ?? root["definitions"]?.object ?? [:]
  }

  private func fresh(_ hint: String?) -> String {
    names += 1
    let base = (hint ?? "Object").replacingOccurrences(
      of: "[^A-Za-z0-9_]", with: "_", options: .regularExpression)
    return "\(base.isEmpty ? "Object" : base)_\(names)"
  }

  func build(_ schema: JSONValue, name hint: String? = nil) throws -> DynamicGenerationSchema {
    if let ref = schema["$ref"]?.string {
      // "#/$defs/Name" | "#/definitions/Name"
      let key = String(ref.split(separator: "/").last ?? "")
      guard let target = definitions[key] else {
        throw AppleFailure(kind: "schema", message: "unknown $ref \(ref)")
      }
      if !built.contains(key) {
        built.insert(key)
        let dep = try build(target, name: key)
        dependencies.append(dep)
      }
      return DynamicGenerationSchema(referenceTo: key)
    }
    let description = schema["description"]?.string
    if let options = schema["enum"]?.strings, !options.isEmpty {
      return DynamicGenerationSchema(name: fresh(hint), description: description, anyOf: options)
    }
    if let const = schema["const"]?.string {
      return DynamicGenerationSchema(name: fresh(hint), description: description, anyOf: [const])
    }
    // anyOf [X, null] (nullable) → X; anyOf of objects → a union
    if let variants = (schema["anyOf"] ?? schema["oneOf"])?.array {
      let real = variants.filter { $0["type"]?.string != "null" }
      if real.count == 1 { return try build(real[0], name: hint) }
      if real.allSatisfy({ $0["type"]?.string == "string" && $0["enum"] != nil }) {
        let all = real.flatMap { $0["enum"]?.strings ?? [] }
        return DynamicGenerationSchema(name: fresh(hint), description: description, anyOf: all)
      }
      let schemas = try real.enumerated().map {
        try build($0.element, name: "\(hint ?? "Choice")\($0.offset)")
      }
      return DynamicGenerationSchema(name: fresh(hint), description: description, anyOf: schemas)
    }
    var type = schema["type"]?.string
    if type == nil, let types = schema["type"]?.strings {
      type = types.first { $0 != "null" }
    }
    switch type {
    case "string":
      return DynamicGenerationSchema(type: String.self)
    case "integer":
      return DynamicGenerationSchema(type: Int.self)
    case "number":
      return DynamicGenerationSchema(type: Double.self)
    case "boolean":
      return DynamicGenerationSchema(type: Bool.self)
    case "array":
      let items = try build(
        schema["items"] ?? .object(["type": .string("string")]), name: hint.map { "\($0)Item" })
      return DynamicGenerationSchema(
        arrayOf: items, minimumElements: schema["minItems"]?.int,
        maximumElements: schema["maxItems"]?.int)
    case "object", nil:
      let properties = schema["properties"]?.object ?? [:]
      let required = Set(schema["required"]?.strings ?? [])
      // A dictionary loses the schema's order, so the properties go by name.
      let props = try properties.keys.sorted().map { key -> DynamicGenerationSchema.Property in
        let sub = properties[key]!
        let nullable = sub["anyOf"]?.array?.contains { $0["type"]?.string == "null" } ?? false
        return DynamicGenerationSchema.Property(
          name: key,
          description: sub["description"]?.string,
          schema: try build(sub, name: key),
          isOptional: !required.contains(key) || nullable)
      }
      return DynamicGenerationSchema(name: fresh(hint), description: description, properties: props)
    default:
      throw AppleFailure(kind: "schema", message: "unsupported type \(type ?? "?")")
    }
  }
}

/** Why the model is not there, as the runtime and the app name it. */
@available(macOS 26.0, iOS 26.0, *)
func appleReason(_ reason: SystemLanguageModel.Availability.UnavailableReason) -> String {
  switch reason {
  case .deviceNotEligible: return "deviceNotEligible"
  case .appleIntelligenceNotEnabled: return "appleIntelligenceNotEnabled"
  case .modelNotReady: return "modelNotReady"
  @unknown default: return "unavailable"
  }
}

/** Whether Apple Intelligence answers on this device right now, else why not. */
@available(macOS 26.0, iOS 26.0, *)
func appleAvailability() -> (available: Bool, reason: String?) {
  switch SystemLanguageModel.default.availability {
  case .available: return (true, nil)
  case .unavailable(let reason): return (false, appleReason(reason))
  }
}

/**
 * Without instructions the model refuses guided calls as "likely unsafe" (seen on macOS 26.5
 * with a billing complaint); any instruction settles it.
 */
let defaultInstructions = "Answer what the prompt asks, precisely and briefly."

/** One answer of the on-device model: text, or JSON that matches the call's schema. */
@available(macOS 26.0, iOS 26.0, *)
func appleGenerate(_ call: Call) async throws -> String {
  let model = call.useCase == "tagging"
    ? SystemLanguageModel(useCase: .contentTagging)
    : SystemLanguageModel.default
  if case .unavailable(let reason) = model.availability {
    throw AppleFailure(kind: "unavailable", message: appleReason(reason))
  }
  let instructions = call.system?.isEmpty == false ? call.system! : defaultInstructions
  let session = LanguageModelSession(model: model, instructions: instructions)
  var options = GenerationOptions()
  if let t = call.temperature { options.temperature = t }
  if let m = call.maxTokens { options.maximumResponseTokens = m }
  do {
    if let schema = call.schema, !schema.isNull {
      let builder = SchemaBuilder(root: schema)
      let root = try builder.build(schema, name: "Answer")
      let generation = try GenerationSchema(root: root, dependencies: builder.dependencies)
      let response = try await session.respond(to: call.prompt, schema: generation, options: options)
      return response.content.jsonString
    }
    let response = try await session.respond(to: call.prompt, options: options)
    return response.content
  } catch let error as AppleFailure {
    throw error
  } catch let error as LanguageModelSession.GenerationError {
    // The description names the case; the kind is what the caller acts on.
    let detail = "\(error.localizedDescription) [\(error)]"
    switch error {
    case .exceededContextWindowSize: throw AppleFailure(kind: "contextWindow", message: detail)
    case .guardrailViolation: throw AppleFailure(kind: "guardrail", message: detail)
    case .rateLimited: throw AppleFailure(kind: "rateLimited", message: detail)
    case .unsupportedLanguageOrLocale: throw AppleFailure(kind: "language", message: detail)
    case .assetsUnavailable: throw AppleFailure(kind: "unavailable", message: detail)
    case .refusal: throw AppleFailure(kind: "refusal", message: detail)
    default: throw AppleFailure(kind: "generation", message: detail)
    }
  } catch {
    throw AppleFailure(kind: "generation", message: "\(error)")
  }
}

/**
 * A recording as text, on the device (SpeechAnalyzer). The language's assets are installed
 * once by the system; the first call of a language waits for them.
 */
@available(macOS 26.0, iOS 26.0, *)
func appleTranscribe(path: String, locale: String) async throws -> String {
  do {
    let transcriber = SpeechTranscriber(locale: Locale(identifier: locale), preset: .transcription)
    if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
      try await request.downloadAndInstall()
    }
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    let file = try AVAudioFile(forReading: URL(fileURLWithPath: path))
    async let collected: String = {
      var text = ""
      for try await result in transcriber.results where result.isFinal {
        text += String(result.text.characters)
      }
      return text
    }()
    if let last = try await analyzer.analyzeSequence(from: file) {
      try await analyzer.finalizeAndFinish(through: last)
    } else {
      await analyzer.cancelAndFinishNow()
    }
    return try await collected.trimmingCharacters(in: .whitespacesAndNewlines)
  } catch let error as AppleFailure {
    throw error
  } catch {
    throw AppleFailure(kind: "transcription", message: "\(error)")
  }
}
