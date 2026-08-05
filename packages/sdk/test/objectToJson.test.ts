import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import sinonChai from "sinon-chai";

chai.use(chaiAsPromised);
chai.use(sinonChai);

describe("@sdk[client/objectToJson]", function () {
	it("should return a object from a json", async function () {
		// Arrange
		const { objectToJson } = await import("../src/client/objectToJson");

		enum ExampleEnum {
			FOO = 0,
			BAR = 1,
			BAZ = 2,
		}

		class RepeatableObject {
			private value: string;

			public getValue(): string {
				return this.value;
			}

			public setValue(value: string): void {
				this.value = value;
			}
		}

		class Example {
			public getFoo(): string {
				return "foo";
			}

			public getBar(): string {
				return "bar";
			}

			public getBaz(): ExampleEnum {
				return ExampleEnum.BAZ;
			}

			public getItemsList(): Array<RepeatableObject> {
				const items = ["foo", "bar", "baz"];
				return items.map((item) => {
					const obj = new RepeatableObject();
					obj.setValue(item);
					return obj;
				});
			}
		}

		const obj = new Example() as unknown as new () => unknown;

		type CreateExampleResponse = {
			foo: string;
			bar: string;
			baz: ExampleEnum;
			items: Array<{ value: string }>;
		};

		// Act
		const result = objectToJson<CreateExampleResponse>(obj, [["baz", ExampleEnum]], null, [
			["itemsList", RepeatableObject],
		]);

		// Assert
		expect(result).to.deep.equal({
			foo: "foo",
			bar: "bar",
			baz: "BAZ",
			items: [
				{
					value: "foo",
				},
				{
					value: "bar",
				},
				{
					value: "baz",
				},
			],
		});
	});
});
