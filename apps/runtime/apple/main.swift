import Foundation

/**
 * `wizards-apple`: Apple's models on this Mac for the runtime (src/harness/apple.ts). One
 * process per call, as the runtime runs every installed AI client; nothing leaves the machine.
 *
 *   wizards-apple status                       → {"available":true} | {"available":false,"reason":…}
 *   wizards-apple generate < call.json         → {"text":…} | {"error":{"kind":…,"message":…}}
 *   wizards-apple transcribe <file> [locale]   → {"text":…} | {"error":…}
 *
 * A call: {"system":…,"prompt":…,"schema":{JSON schema}|null,"useCase":"general"|"tagging",
 * "maxTokens":…}. With a schema the answer is the model's guided generation, as JSON. The
 * code that does the work is Shared.swift, the same the app's module runs on an iPhone.
 */

func emit(_ object: [String: Any]) {
  let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func fail(_ kind: String, _ message: String) -> Never {
  emit(["error": ["kind": kind, "message": message]])
  exit(1)
}

func status() {
  let v = ProcessInfo.processInfo.operatingSystemVersion
  let os = "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
  let a = appleAvailability()
  emit(a.available ? ["available": true, "os": os] : ["available": false, "reason": a.reason ?? "unavailable", "os": os])
}

func generate() async {
  let input = FileHandle.standardInput.readDataToEndOfFile()
  let call: Call
  do {
    call = try JSONDecoder().decode(Call.self, from: input)
  } catch {
    fail("badCall", "\(error)")
  }
  do {
    emit(["text": try await appleGenerate(call)])
  } catch let error as AppleFailure {
    fail(error.kind, error.message)
  } catch {
    fail("generation", "\(error)")
  }
}

func transcribe(_ args: [String]) async {
  guard let path = args.first else {
    fail("badCall", "usage: wizards-apple transcribe <file> [locale]")
  }
  do {
    emit(["text": try await appleTranscribe(path: path, locale: args.dropFirst().first ?? "en-US")])
  } catch let error as AppleFailure {
    fail(error.kind, error.message)
  } catch {
    fail("transcription", "\(error)")
  }
}

@main
struct Main {
  static func main() async {
    let args = Array(CommandLine.arguments.dropFirst())
    switch args.first ?? "status" {
    case "status": status()
    case "generate": await generate()
    case "transcribe": await transcribe(Array(args.dropFirst()))
    default: fail("badCommand", "usage: wizards-apple status | generate < call.json | transcribe <file> [locale]")
    }
  }
}
