import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { createSandbox } from "sinon";
import sinonChai from "sinon-chai";

chai.use(chaiAsPromised);
chai.use(sinonChai);
const sandbox = createSandbox();

describe("@sdk[client/jsonToObject]", function () {
	afterEach(function () {
		return sandbox.restore();
	});

	it("should return a new instance of the object", async function () {
		// Arrange
		const { jsonToObject } = await import("../src/client/jsonToObject");

		enum ExampleEnum {
			VALUE1 = 0,
			VALUE2 = 1,
		}

		class EmbeddedObject {
			private name: string;

			public setName(name: string): void {
				this.name = name;
			}

			public getName(): string {
				return this.name;
			}
		}

		class CreateExampleRequest {
			private name: string;
			private marray: string[];
			private enumValue: ExampleEnum;
			private embeddedObject: EmbeddedObject;

			public setName(name: string): void {
				this.name = name;
			}

			public getName(): string {
				return this.name;
			}

			public setMarray(marray: string[]): void {
				this.marray = marray;
			}

			public getMarray(): string[] {
				return this.marray;
			}

			public setEnumValue(enumValue: ExampleEnum): void {
				this.enumValue = enumValue;
			}

			public getEnumValue(): ExampleEnum {
				return this.enumValue;
			}

			public setEmbeddedObject(embeddedObject: EmbeddedObject): void {
				this.embeddedObject = embeddedObject;
			}

			public getEmbeddedObject(): EmbeddedObject {
				return this.embeddedObject;
			}
		}

		const jsonObj = {
			name: "test",
			marray: ["test1", "test2"],
			enumValue: "VALUE1",
			embeddedObject: {
				name: "embedded",
			},
		};

		// Act
		const result = jsonToObject<{ name: string }, CreateExampleRequest>({
			json: jsonObj,
			objectConstructor: CreateExampleRequest,
			enumMapping: [["enumValue", ExampleEnum]],
			objectMapping: [["embeddedObject", EmbeddedObject]],
		});

		// Assert
		expect(result).to.be.an.instanceOf(Object);
		expect(result.getName()).to.be.equal(jsonObj.name);
		expect(result.getMarray()).to.be.eql(jsonObj.marray);
		expect(result.getEnumValue()).to.be.equal(ExampleEnum.VALUE1);
		expect(result.getEmbeddedObject()).to.be.an.instanceOf(EmbeddedObject);
		expect(result.getEmbeddedObject().getName()).to.be.equal(jsonObj.embeddedObject.name);
	});
});
