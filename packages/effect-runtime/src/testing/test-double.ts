/**
 * Marks an intentionally partial or dynamically patched test double.
 *
 * The dynamic return type is isolated here so test setup can model private collaborators
 * without spreading unsafe assertions across every specification.
 */
// oxlint-disable-next-line typescript/no-explicit-any -- Required test-only dynamic double boundary.
export function testDouble(value: unknown): any {
	return value;
}
