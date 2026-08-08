/**
 * A PE32 image carrying nothing but a version resource, for the tests of the version reader and of everything
 * that reads a version through it. Built rather than vendored because a real `ddraw.dll` is nearly a megabyte
 * and what the reader has to get right is the resource, not the code.
 *
 * Deliberately not exported from the package index: nothing ZAX ships writes PE images.
 */

import { NtExecutable, NtExecutableResource } from "pe-library";
import { Resource } from "resedit";

export function library(values: Record<string, string>): Uint8Array {
  const stub = new ArrayBuffer(0x400);
  const view = new DataView(stub);
  const bytes = new Uint8Array(stub);
  bytes.set([0x4d, 0x5a]); // MZ
  view.setUint32(0x3c, 0x80, true); // where the PE header starts
  const pe = 0x80;
  bytes.set([0x50, 0x45, 0, 0], pe); // PE\0\0
  view.setUint16(pe + 4, 0x014c, true); // i386
  view.setUint16(pe + 20, 224, true); // size of the PE32 optional header
  view.setUint16(pe + 22, 0x2102, true); // a 32-bit executable DLL
  const optional = pe + 24;
  view.setUint16(optional, 0x10b, true); // PE32
  view.setUint32(optional + 28, 0x1000, true); // base of code
  view.setUint32(optional + 32, 0x10000000, true); // image base
  view.setUint32(optional + 36, 0x1000, true); // section alignment
  view.setUint32(optional + 40, 0x200, true); // file alignment
  view.setUint32(optional + 56, 0x2000, true); // size of image
  view.setUint32(optional + 60, 0x400, true); // size of headers
  view.setUint16(optional + 68, 2, true); // GUI subsystem
  view.setUint32(optional + 92, 16, true); // number of data directories

  const image = NtExecutable.from(stub, { ignoreCert: true });
  const resources = NtExecutableResource.from(image);
  const info = Resource.VersionInfo.createEmpty();
  info.setStringValues({ lang: 1033, codepage: 0 }, values);
  info.outputToResourceEntries(resources.entries);
  resources.outputResource(image);
  return new Uint8Array(image.generate());
}
