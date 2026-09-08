import type * as FileUtils from '@libs/fileDownload/FileUtils';
import type PrepareRequestPayload from '@libs/prepareRequestPayload/types';
import type * as ReceiptStorage from '@libs/ReceiptStorage';

const mockLogAlert = jest.fn();
jest.mock('@libs/Log', () => ({
    __esModule: true,
    default: {alert: mockLogAlert},
}));

const mockCheckFileExists = jest.fn<Promise<boolean>, [string | undefined]>();
jest.mock('@libs/fileDownload/checkFileExists', () => ({
    __esModule: true,
    default: mockCheckFileExists,
}));

const mockReadFileAsync = jest.fn();
jest.mock('@libs/fileDownload/FileUtils', () => ({
    ...jest.requireActual<typeof FileUtils>('@libs/fileDownload/FileUtils'),
    readFileAsync: mockReadFileAsync,
}));

const mockValidateFormDataParameter = jest.fn();
jest.mock('@libs/validateFormDataParameter', () => ({
    __esModule: true,
    default: mockValidateFormDataParameter,
}));

const mockLogReceiptDropped = jest.fn();
jest.mock('@libs/telemetry/ReceiptObservability', () => ({
    logReceiptDropped: mockLogReceiptDropped,
}));

const RECEIPTS_FOLDER = '/Containers/Data/Application/CURRENT/Documents/Receipts-Upload';
jest.mock('@libs/getReceiptsUploadFolderPath', () => ({
    __esModule: true,
    default: () => RECEIPTS_FOLDER,
}));
jest.mock('@libs/ReceiptStorage', () => jest.requireActual<typeof ReceiptStorage>('@libs/ReceiptStorage/index.native.ts'));

// Bypass the global jest/setup.ts mock to test the real native implementation.
// Dependencies above are still resolved through their respective mocks.

const {default: prepareRequestPayload}: {default: PrepareRequestPayload} = jest.requireActual('@libs/prepareRequestPayload/index.native.ts');

describe('prepareRequestPayload (native)', () => {
    beforeEach(() => {
        mockReadFileAsync.mockReset();
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    it('should include receipt in FormData when the file exists', async () => {
        mockCheckFileExists.mockResolvedValue(true);

        const receipt = {
            source: 'file:///var/mobile/Documents/Receipts-Upload/receipt.jpg',
            name: 'receipt.jpg',
            type: 'image/jpeg',
            uri: 'file:///var/mobile/Documents/Receipts-Upload/receipt.jpg',
        };

        const formData = await prepareRequestPayload('RequestMoney', {receipt, amount: '100'}, false);

        expect(formData.has('receipt')).toBe(true);
        expect(formData.get('amount')).toBe('100');
    });

    it('should log a joinable [Receipt] dropped line and omit receipt from FormData when file does not exist', async () => {
        mockCheckFileExists.mockResolvedValue(false);

        const receipt = {
            source: 'file:///var/mobile/Library/Caches/ImageManipulator/receipt.jpg',
            name: 'receipt.jpg',
            type: 'image/jpeg',
            uri: 'file:///var/mobile/Library/Caches/ImageManipulator/receipt.jpg',
            receiptTraceId: 'trace-123',
        };

        const formData = await prepareRequestPayload('RequestMoney', {receipt, transactionID: 'txn-456', amount: '100'}, false);

        expect(formData.has('receipt')).toBe(false);
        expect(formData.get('amount')).toBe('100');
        // The drop carries the trace id and transaction id so it joins the capture/enqueue lines on the [Receipt] spine.
        expect(mockLogReceiptDropped).toHaveBeenCalledWith({
            receiptTraceId: 'trace-123',
            transactionID: 'txn-456',
            command: 'RequestMoney',
            source: 'file:///var/mobile/Library/Caches/ImageManipulator/receipt.jpg',
            fileName: 'receipt.jpg',
        });
    });

    it('should recover a queued receipt whose stored path names a stale container, by re-rooting the filename', async () => {
        mockCheckFileExists.mockResolvedValue(true);

        const receipt = {
            // Written before an app upgrade. The device no longer has this container.
            source: 'file:///Containers/Data/Application/STALE/Documents/Receipts-Upload/receipt_9.jpg',
            uri: 'file:///Containers/Data/Application/STALE/Documents/Receipts-Upload/receipt_9.jpg',
            name: 'receipt.jpg',
            type: 'image/jpeg',
        };

        const formData = await prepareRequestPayload('RequestMoney', {receipt, amount: '100'}, false);

        expect(mockCheckFileExists).toHaveBeenCalledWith(`file://${RECEIPTS_FOLDER}/receipt_9.jpg`);
        expect(formData.has('receipt')).toBe(true);
        expect(mockValidateFormDataParameter).toHaveBeenCalledWith('RequestMoney', 'receipt', expect.objectContaining({uri: `file://${RECEIPTS_FOLDER}/receipt_9.jpg`}));
        expect(mockLogReceiptDropped).not.toHaveBeenCalled();
    });

    it('should still report a genuinely missing file as dropped', async () => {
        mockCheckFileExists.mockResolvedValue(false);

        const receipt = {
            source: 'file:///Containers/Data/Application/CURRENT/Documents/Receipts-Upload/gone.jpg',
            uri: 'file:///Containers/Data/Application/CURRENT/Documents/Receipts-Upload/gone.jpg',
            name: 'receipt.jpg',
            type: 'image/jpeg',
        };

        const formData = await prepareRequestPayload('RequestMoney', {receipt, amount: '100'}, false);

        expect(formData.has('receipt')).toBe(false);
        expect(mockLogReceiptDropped).toHaveBeenCalledWith(expect.objectContaining({source: `file://${RECEIPTS_FOLDER}/gone.jpg`}));
    });

    it('should not check the filesystem for a bundled placeholder receipt', async () => {
        // Distance and per diem expenses carry a require() asset id. No file exists on disk.
        const receipt = {source: 686, name: 'receipt-generic.png', type: 'image/png'};

        const formData = await prepareRequestPayload('AddTrackedExpenseToPolicy', {receipt, amount: '100'}, false);

        expect(mockCheckFileExists).not.toHaveBeenCalled();
        expect(mockLogReceiptDropped).not.toHaveBeenCalled();
        expect(formData.has('receipt')).toBe(false);
        expect(formData.get('amount')).toBe('100');
    });

    it('should handle non-receipt data normally', async () => {
        const formData = await prepareRequestPayload('SomeCommand', {amount: '100', currency: 'USD'}, false);

        expect(formData.get('amount')).toBe('100');
        expect(formData.get('currency')).toBe('USD');
    });

    it('should recover an offline attachment from a previous app container without dropping its bytes', async () => {
        const currentSource = `file://${RECEIPTS_FOLDER}/photo_9.jpg`;
        const attachment = new File(['queued image bytes'], 'photo.jpg', {type: 'image/jpeg'});
        mockReadFileAsync.mockImplementation((source: string) => Promise.resolve(source === currentSource ? attachment : undefined));

        const formData = await prepareRequestPayload(
            'AddTextAndAttachment',
            {
                file: {source: 'file:///Containers/Data/Application/STALE/Documents/Receipts-Upload/photo_9.jpg', name: 'photo.jpg', type: 'image/jpeg'},
                reportComment: 'Photo from yesterday',
            },
            true,
        );

        expect(formData.get('file')).toBe(attachment);
        expect(formData.get('reportComment')).toBe('Photo from yesterday');
        expect(mockReadFileAsync).toHaveBeenCalledWith(currentSource, 'photo.jpg', expect.any(Function), undefined, 'image/jpeg');
        expect(mockLogAlert).not.toHaveBeenCalled();
    });

    it('should report an unreadable offline attachment without exposing its name, path, or comment', async () => {
        mockReadFileAsync.mockResolvedValue(undefined);

        const formData = await prepareRequestPayload(
            'AddTextAndAttachment',
            {
                file: {source: `file://${RECEIPTS_FOLDER}/private-photo.jpg`, name: 'private-photo.jpg', type: 'image/jpeg'},
                reportID: '123',
                clientID: '456',
                reportComment: 'Private comment',
            },
            true,
        );

        expect(formData.has('file')).toBe(false);
        expect(formData.get('reportComment')).toBe('Private comment');
        expect(mockLogAlert).toHaveBeenCalledTimes(1);
        expect(mockLogAlert).toHaveBeenCalledWith('[Attachment] Failed to read offline file during payload preparation', {command: 'AddTextAndAttachment'});
        expect(mockLogReceiptDropped).not.toHaveBeenCalled();
    });

    it.each(['file:///cache/photo.jpg', 'https://example.com/photo.jpg', 'content://media/external/images/123'])('should preserve non-receipt attachment sources: %s', async (source) => {
        const attachment = new File(['image'], 'photo.jpg', {type: 'image/jpeg'});
        mockReadFileAsync.mockResolvedValue(attachment);

        const formData = await prepareRequestPayload('AddAttachment', {file: {source, uri: source, name: 'photo.jpg', type: 'image/jpeg'}}, true);

        expect(mockReadFileAsync).toHaveBeenCalledWith(source, 'photo.jpg', expect.any(Function), undefined, 'image/jpeg');
        expect(formData.get('file')).toBe(attachment);
        expect(mockLogAlert).not.toHaveBeenCalled();
    });

    it.each([
        [`file://${RECEIPTS_FOLDER}/photo%2523.jpg`, `file://${RECEIPTS_FOLDER}/photo%23.jpg`],
        [`${RECEIPTS_FOLDER}/photo%23.jpg`, `file://${RECEIPTS_FOLDER}/photo%23.jpg`],
        [`file://${RECEIPTS_FOLDER}/photo%20%231.jpg`, `file://${RECEIPTS_FOLDER}/photo #1.jpg`],
    ])('should preserve a readable original attachment when resolving changes its filename: %s', async (source, resolvedSource) => {
        const attachment = new File(['original image'], 'photo.jpg', {type: 'image/jpeg'});
        const otherAttachment = new File(['different image'], 'other.jpg', {type: 'image/jpeg'});
        const readableFiles = new Map([
            [source, attachment],
            [resolvedSource, otherAttachment],
        ]);
        mockReadFileAsync.mockImplementation((path: string) => Promise.resolve(readableFiles.get(path)));

        const formData = await prepareRequestPayload('AddAttachment', {file: {source, name: 'photo.jpg', type: 'image/jpeg'}}, true);

        expect(formData.get('file') === attachment).toBe(true);
        expect(mockReadFileAsync).toHaveBeenCalledTimes(1);
        expect(mockReadFileAsync).toHaveBeenCalledWith(source, 'photo.jpg', expect.any(Function), undefined, 'image/jpeg');
        expect(mockLogAlert).not.toHaveBeenCalled();
    });

    it.each([
        ['file:///Containers/Data/Application/STALE/Documents/Receipts-Upload/photo%2523.jpg', 'photo%2523.jpg', 'photo%23.jpg'],
        ['/Containers/Data/Application/STALE/Documents/Receipts-Upload/photo%23.jpg', 'photo%2523.jpg', 'photo%23.jpg'],
        ['file:///Containers/Data/Application/STALE/Documents/Receipts-Upload/photo%20%231.jpg', 'photo%20%231.jpg', 'photo #1.jpg'],
    ])('should preserve the filename encoding when recovering an attachment from a stale container: %s', async (source, encodedName, decodedName) => {
        const currentSource = `file://${RECEIPTS_FOLDER}/${encodedName}`;
        const attachment = new File(['queued image'], 'photo.jpg', {type: 'image/jpeg'});
        const otherAttachment = new File(['different image'], 'other.jpg', {type: 'image/jpeg'});
        const readableFiles = new Map([
            [currentSource, attachment],
            [`file://${RECEIPTS_FOLDER}/${decodedName}`, otherAttachment],
        ]);
        mockReadFileAsync.mockImplementation((path: string) => Promise.resolve(readableFiles.get(path)));

        const formData = await prepareRequestPayload('AddAttachment', {file: {source, name: 'photo.jpg', type: 'image/jpeg'}}, true);

        expect(formData.get('file') === attachment).toBe(true);
        expect(mockReadFileAsync).toHaveBeenCalledTimes(2);
        expect(mockReadFileAsync).toHaveBeenNthCalledWith(1, source, 'photo.jpg', expect.any(Function), undefined, 'image/jpeg');
        expect(mockReadFileAsync).toHaveBeenNthCalledWith(2, currentSource, 'photo.jpg', expect.any(Function), undefined, 'image/jpeg');
        expect(mockLogAlert).not.toHaveBeenCalled();
    });

    it.each([
        [`file://${RECEIPTS_FOLDER}/missing%2523.jpg`, 1],
        ['file:///Containers/Data/Application/STALE/Documents/Receipts-Upload/missing%2523.jpg', 2],
    ])('should report a missing attachment once without reading the same URI twice: %s', async (source, expectedReads) => {
        mockReadFileAsync.mockResolvedValue(undefined);

        const formData = await prepareRequestPayload('AddAttachment', {file: {source, name: 'photo.jpg', type: 'image/jpeg'}}, true);

        expect(formData.has('file')).toBe(false);
        expect(mockReadFileAsync).toHaveBeenCalledTimes(expectedReads);
        expect(mockLogAlert).toHaveBeenCalledTimes(1);
        expect(mockLogAlert).toHaveBeenCalledWith('[Attachment] Failed to read offline file during payload preparation', {command: 'AddAttachment'});
    });

    it('should preserve files without a stored source and online uploads', async () => {
        const attachment = new File(['image'], 'photo.jpg', {type: 'image/jpeg'});

        const offlineFormData = await prepareRequestPayload('AddAttachment', {file: attachment}, true);
        const onlineFormData = await prepareRequestPayload('AddAttachment', {file: attachment}, false);

        expect(offlineFormData.get('file')).toBe(attachment);
        expect(onlineFormData.get('file')).toBe(attachment);
        expect(mockReadFileAsync).not.toHaveBeenCalled();
        expect(mockLogAlert).not.toHaveBeenCalled();
    });

    it('should skip undefined values', async () => {
        const formData = await prepareRequestPayload('SomeCommand', {amount: '100', undefinedField: undefined}, false);

        expect(formData.get('amount')).toBe('100');
        expect(formData.has('undefinedField')).toBe(false);
    });
});
