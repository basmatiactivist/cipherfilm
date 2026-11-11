// A small Swift wrapper around ONNX Runtime's C API: one environment, CPU sessions in fp32 (as on the phone), float,
// int32 and int64 tensors in, float tensors out.
import Foundation
import onnxruntime

enum ORT {
  nonisolated(unsafe) static let api: UnsafePointer<OrtApi> = OrtGetApiBase().pointee.GetApi(UInt32(ORT_API_VERSION))!

  static func check(_ s: OpaquePointer?) throws {
    guard let s else { return }
    let msg = String(cString: api.pointee.GetErrorMessage(s)!)
    api.pointee.ReleaseStatus(s)
    throw CryptoError.failed("ONNX Runtime: \(msg)")
  }

  nonisolated(unsafe) static let env: OpaquePointer = {
    var e: OpaquePointer?
    _ = api.pointee.CreateEnv(ORT_LOGGING_LEVEL_ERROR, "cipherfilm", &e)
    _ = api.pointee.DisableTelemetryEvents(e) // Cipherfilm talks only to its own server
    return e!
  }()

  nonisolated(unsafe) static let cpu: OpaquePointer = {
    var m: OpaquePointer?
    _ = api.pointee.CreateCpuMemoryInfo(OrtArenaAllocator, OrtMemTypeDefault, &m)
    return m!
  }()

  static var version: String { String(cString: OrtGetApiBase().pointee.GetVersionString()!) }
}

final class OrtModel: @unchecked Sendable {
  private let session: OpaquePointer
  let inputNames: [String]
  let outputNames: [String]
  private let lock = NSLock()

  init(path: URL, threads: Int32) throws {
    let a = ORT.api.pointee
    var opts: OpaquePointer?
    try ORT.check(a.CreateSessionOptions(&opts))
    defer { a.ReleaseSessionOptions(opts) }
    try ORT.check(a.SetIntraOpNumThreads(opts, threads))
    try ORT.check(a.SetSessionGraphOptimizationLevel(opts, ORT_ENABLE_ALL))
    var s: OpaquePointer?
    try ORT.check(path.path.withCString { a.CreateSession(ORT.env, $0, opts, &s) })
    session = s!
    var alloc: UnsafeMutablePointer<OrtAllocator>?
    try ORT.check(a.GetAllocatorWithDefaultOptions(&alloc))
    func names(_ count: (OpaquePointer?, UnsafeMutablePointer<Int>?) -> OpaquePointer?, _ get: (OpaquePointer?, Int, UnsafeMutablePointer<OrtAllocator>?, UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?) -> OpaquePointer?) throws -> [String] {
      var n = 0
      try ORT.check(count(s, &n))
      return try (0..<n).map { i in
        var p: UnsafeMutablePointer<CChar>?
        try ORT.check(get(s, i, alloc, &p))
        defer { _ = alloc!.pointee.Free(alloc, p) }
        return String(cString: p!)
      }
    }
    inputNames = try names(a.SessionGetInputCount, a.SessionGetInputName)
    outputNames = try names(a.SessionGetOutputCount, a.SessionGetOutputName)
  }

  deinit { ORT.api.pointee.ReleaseSession(session) }

  enum Input { case float([Float], [Int64]); case int64([Int64], [Int64]); case int32([Int32], [Int64]) }

  /** Runs the model on one input and returns the requested outputs (all of them by default) as flat float arrays. */
  func run(_ input: Input, outputs wanted: [String]? = nil) throws -> [String: [Float]] {
    let a = ORT.api.pointee
    let outs = wanted ?? outputNames
    // the tensor points into this buffer, which lives until the run is over
    let (buf, bytes, shape, type): (UnsafeMutableRawPointer, Int, [Int64], ONNXTensorElementDataType) = {
      switch input {
      case .float(let d, let s):
        let b = UnsafeMutableRawPointer.allocate(byteCount: max(4, d.count * 4), alignment: 16)
        d.withUnsafeBytes { b.copyMemory(from: $0.baseAddress!, byteCount: $0.count) }
        return (b, d.count * 4, s, ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT)
      case .int64(let d, let s):
        let b = UnsafeMutableRawPointer.allocate(byteCount: max(8, d.count * 8), alignment: 16)
        d.withUnsafeBytes { b.copyMemory(from: $0.baseAddress!, byteCount: $0.count) }
        return (b, d.count * 8, s, ONNX_TENSOR_ELEMENT_DATA_TYPE_INT64)
      case .int32(let d, let s):
        let b = UnsafeMutableRawPointer.allocate(byteCount: max(4, d.count * 4), alignment: 16)
        d.withUnsafeBytes { b.copyMemory(from: $0.baseAddress!, byteCount: $0.count) }
        return (b, d.count * 4, s, ONNX_TENSOR_ELEMENT_DATA_TYPE_INT32)
      }
    }()
    defer { buf.deallocate() }
    return try lock.withLock {
      var value: OpaquePointer?
      try ORT.check(a.CreateTensorWithDataAsOrtValue(ORT.cpu, buf, bytes, shape, shape.count, type, &value))
      defer { a.ReleaseValue(value) }
      var results = [OpaquePointer?](repeating: nil, count: outs.count)
      let inName = strdup(inputNames[0])!
      let outNames = outs.map { UnsafePointer(strdup($0)!) }
      defer { free(inName); outNames.forEach { free(UnsafeMutablePointer(mutating: $0)) } }
      var inNames: [UnsafePointer<CChar>?] = [UnsafePointer(inName)]
      var inputs: [OpaquePointer?] = [value]
      var on: [UnsafePointer<CChar>?] = outNames
      try ORT.check(a.Run(session, nil, &inNames, &inputs, 1, &on, outs.count, &results))
      defer { results.forEach { a.ReleaseValue($0) } }
      var out: [String: [Float]] = [:]
      for (k, r) in zip(outs, results) {
        var info: OpaquePointer?
        try ORT.check(a.GetTensorTypeAndShape(r, &info))
        var count = 0
        var elem = ONNX_TENSOR_ELEMENT_DATA_TYPE_UNDEFINED
        let st = a.GetTensorShapeElementCount(info, &count) ?? a.GetTensorElementType(info, &elem)
        a.ReleaseTensorTypeAndShapeInfo(info)
        try ORT.check(st)
        // read as floats below: anything else is refused, not reinterpreted
        guard elem == ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT else { throw CryptoError.failed("ONNX Runtime: \(k) isn't a float tensor") }
        var p: UnsafeMutableRawPointer?
        try ORT.check(a.GetTensorMutableData(r, &p))
        out[k] = Array(UnsafeBufferPointer(start: p!.assumingMemoryBound(to: Float.self), count: count))
      }
      return out
    }
  }

  /** The first output's leading `dim` values (a model's embedding); fails when the output is shorter. */
  func vector(_ input: Input, dim: Int) throws -> [Float] {
    let name = outputNames[0]
    guard let v = try run(input, outputs: [name])[name], v.count >= dim else { throw CryptoError.failed("ONNX Runtime: \(name) is too short") }
    return Array(v.prefix(dim))
  }
}
