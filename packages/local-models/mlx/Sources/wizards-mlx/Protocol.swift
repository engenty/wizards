import Foundation
import MLXLMCommon

/// What comes in, one JSON object per line: a chat in the shape of Ollama's chat API with the
/// model's folder, a call to give up, or the model to let go of.
struct Request: Decodable {
    var id: String?
    var chat: ChatRequest?
    var cancel: Bool?
    var unload: Bool?
}

struct ChatRequest: Decodable {
    struct Function: Decodable {
        var name: String
        var arguments: JSONValue
    }
    struct Call: Decodable {
        var function: Function
    }
    struct Message: Decodable {
        var role: String
        var content: String?
        /// Pictures, base64.
        var images: [String]?
        var tool_calls: [Call]?
        var tool_name: String?
    }
    struct Options: Decodable {
        var num_ctx: Int?
        var num_predict: Int?
        var temperature: Float?
        var top_p: Float?
        var top_k: Int?
        var seed: UInt64?
    }
    /// The folder the model is in.
    var model: String
    var messages: [Message]
    var tools: [JSONValue]?
    /// The JSON schema the answer has to match, as text: its order is the answer's.
    var schema: String?
    var think: Bool?
    var options: Options?
}

/// What goes out, one JSON object per line.
struct Chunk: Encodable {
    struct Function: Encodable {
        var name: String
        var arguments: [String: JSONValue]
    }
    struct Call: Encodable {
        var function: Function
    }
    struct Message: Encodable {
        var content: String?
        var thinking: String?
        var tool_calls: [Call]?
    }
    var id: String
    var message: Message?
    var done: Bool?
    var done_reason: String?
    var prompt_eval_count: Int?
    var eval_count: Int?
    /// Seconds, and bytes of memory.
    var prompt_seconds: Double?
    var eval_seconds: Double?
    var cached: Int?
    var memory: Int?
    var error: String?
}

extension JSONValue {
    var sendable: any Sendable {
        switch self {
        case .null: return String?.none as any Sendable
        case .bool(let v): return v
        case .int(let v): return v
        case .double(let v): return v
        case .string(let v): return v
        case .array(let v): return v.map { $0.sendable }
        case .object(let v): return v.mapValues { $0.sendable }
        }
    }
    var object: [String: JSONValue]? {
        if case .object(let v) = self { return v }
        return nil
    }
}

/// One line at a time: calls answer in their own tasks.
actor Out {
    static let shared = Out()
    private let encoder = JSONEncoder()
    func send(_ chunk: Chunk) {
        guard var data = try? encoder.encode(chunk) else { return }
        data.append(0x0A)
        FileHandle.standardOutput.write(data)
    }
}
