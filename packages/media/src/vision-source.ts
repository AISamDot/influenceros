/** Source of the Apple Vision helper (compiled once with the system `swiftc`; see vision.ts). */
export const VISION_SWIFT = String.raw`// Apple Vision helper for stream E's QC (OCR for Q4 captions, face similarity for Q3). Runs on the Mac worker only.
// Usage: troupe-vision ocr <image>            -> {"text": "...", "confidence": 0.97}
//        troupe-vision face <reference> <image> -> {"faces": 1, "similarity": 0.83}
// Local OS frameworks only: no network, no model download, no third-party weights (commercial use is fine).
import AppKit
import Foundation
import Vision

func load(_ path: String) -> CGImage? {
  guard let img = NSImage(contentsOfFile: path) else { return nil }
  var rect = CGRect(origin: .zero, size: img.size)
  return img.cgImage(forProposedRect: &rect, context: nil, hints: nil)
}

func emit(_ obj: [String: Any]) {
  let data = try! JSONSerialization.data(withJSONObject: obj)
  FileHandle.standardOutput.write(data)
}

func faces(_ img: CGImage) throws -> [VNFaceObservation] {
  let req = VNDetectFaceRectanglesRequest()
  try VNImageRequestHandler(cgImage: img).perform([req])
  return req.results ?? []
}

func crop(_ img: CGImage, _ f: VNFaceObservation) -> CGImage? {
  let w = CGFloat(img.width), h = CGFloat(img.height), b = f.boundingBox
  let r = CGRect(x: b.minX * w, y: (1 - b.maxY) * h, width: b.width * w, height: b.height * h)
    .insetBy(dx: -b.width * w * 0.15, dy: -b.height * h * 0.15)
    .intersection(CGRect(x: 0, y: 0, width: w, height: h))
  return img.cropping(to: r)
}

func featurePrint(_ img: CGImage) throws -> VNFeaturePrintObservation? {
  let req = VNGenerateImageFeaturePrintRequest()
  try VNImageRequestHandler(cgImage: img).perform([req])
  return req.results?.first
}

let args = CommandLine.arguments
do {
  if args.count >= 3 && args[1] == "ocr" {
    guard let img = load(args[2]) else { emit(["error": "unreadable image"]); exit(2) }
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.recognitionLanguages = ["en-US"]
    req.usesLanguageCorrection = false
    try VNImageRequestHandler(cgImage: img).perform([req])
    let lines = (req.results ?? []).compactMap { $0.topCandidates(1).first }
    let conf = lines.isEmpty ? 0.0 : lines.map { Double($0.confidence) }.reduce(0, +) / Double(lines.count)
    emit(["text": lines.map { $0.string }.joined(separator: "\n"), "confidence": conf])
  } else if args.count >= 4 && args[1] == "face" {
    guard let ref = load(args[2]), let img = load(args[3]) else { emit(["error": "unreadable image"]); exit(2) }
    let rf = try faces(ref).max { $0.boundingBox.width < $1.boundingBox.width }
    let found = try faces(img)
    let f = found.max { $0.boundingBox.width < $1.boundingBox.width }
    guard let rf = rf, let f = f, let a = crop(ref, rf), let b = crop(img, f),
      let pa = try featurePrint(a), let pb = try featurePrint(b)
    else { emit(["faces": found.count, "similarity": NSNull()]); exit(0) }
    var d: Float = 0
    try pa.computeDistance(&d, to: pb)
    emit(["faces": found.count, "similarity": max(0, 1 - Double(min(d, 1.4)) / 1.4), "distance": Double(d)])
  } else {
    emit(["error": "usage: troupe-vision ocr <image> | face <reference> <image>"]); exit(64)
  }
} catch {
  emit(["error": "\(error)"]); exit(1)
}
`;
