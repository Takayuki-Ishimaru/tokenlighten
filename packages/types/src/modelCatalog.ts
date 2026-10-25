/** Immutable provenance shared by the local embedding runtime and license UIs. */
export const MULTILINGUAL_E5_MODEL = Object.freeze({
  id: "Xenova/multilingual-e5-small",
  revision: "761b726dd34fb83930e26aab4e9ac3899aa1fa78",
  dimensions: 384,
  dtype: "q8" as const,
  license: "MIT",
  licenseProvenance: "upstream-model-card" as const,
  source: "https://huggingface.co/Xenova/multilingual-e5-small/tree/761b726dd34fb83930e26aab4e9ac3899aa1fa78",
  upstream: "intfloat/multilingual-e5-small",
  upstreamRevision: "614241f622f53c4eeff9890bdc4f31cfecc418b3",
  licenseSource: "https://huggingface.co/intfloat/multilingual-e5-small/blob/614241f622f53c4eeff9890bdc4f31cfecc418b3/README.md",
  copyright: "Copyright (c) Microsoft Corporation",
  noticeSource: "https://github.com/microsoft/unilm/blob/master/LICENSE",
  noticeFiles: ["THIRD_PARTY_NOTICES.md", "MODEL_LICENSES.json"] as readonly string[],
  // The conversion repository links the upstream model but does not declare
  // a separate license. Do not present an invented converter copyright.
  note: "ONNX conversion of the MIT-licensed upstream model; the conversion repository declares no separate license.",
});

export const E5_MIT_NOTICE = `The MIT License (MIT)

Copyright (c) Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
