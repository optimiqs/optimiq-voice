import * as chai from "chai";
import { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { createSandbox, match } from "sinon";
import sinonChai from "sinon-chai";
import { AudioSocket } from "../src";

chai.use(chaiAsPromised);
chai.use(sinonChai);
const sandbox = createSandbox();

describe("@streams/AudioSocket", function () {
  afterEach(function () {
    return sandbox.restore();
  });

  it("should create a new instance", function () {
    // Arrange
    const audioSocket = new AudioSocket();

    // Assert
    expect(audioSocket).to.be.instanceOf(AudioSocket);
  });

  it("should listen on a port", function () {
    // Arrange
    const audioSocket = new AudioSocket();

    const listenStub = sandbox.stub(audioSocket, "listen");

    // Act
    audioSocket.listen(8080);

    // Assert
    expect(listenStub).to.have.been.calledOnce;
    expect(listenStub).to.have.been.calledWith(8080);
  });

  it("should listen on a port and bind", function () {
    // Arrange
    const audioSocket = new AudioSocket();

    const listenStub = sandbox.stub(audioSocket, "listen");

    // Act
    audioSocket.listen(8080, "127.0.0.1");

    // Assert
    expect(listenStub).to.have.been.calledOnce;
    expect(listenStub).to.have.been.calledWith(8080, "127.0.0.1");
  });

  it("should listen on a port and bind with a callback", function () {
    // Arrange
    const audioSocket = new AudioSocket();

    const listenStub = sandbox.stub(audioSocket, "listen");

    // Act
    audioSocket.listen(8080, "127.0.0.1", () => {});

    // Assert
    expect(listenStub).to.have.been.calledOnce;
    expect(listenStub).to.have.been.calledWith(8080, "127.0.0.1", match.func);
  });
});
