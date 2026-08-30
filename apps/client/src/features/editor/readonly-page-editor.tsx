import "@/features/editor/styles/index.css";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Editor, EditorProvider } from "@tiptap/react";
import { mainExtensions } from "@/features/editor/extensions/extensions";
import { Document } from "@tiptap/extension-document";
import { Heading, UniqueID } from "@docmost/editor-ext";
import { Text } from "@tiptap/extension-text";
import { Placeholder } from "@tiptap/extension-placeholder";
import { useAtom } from "jotai";
import {
  lightboxRequestAtom,
  readOnlyEditorAtom,
} from "@/features/editor/atoms/editor-atoms.ts";
import { useEditorScroll } from "./hooks/use-editor-scroll";
import { TransclusionLookupProvider } from "@/features/editor/components/transclusion/transclusion-lookup-context";
import LightboxView, {
  getLightboxClickRequest,
} from "@/features/editor/components/common/lightbox-view";

interface PageEditorProps {
  pageId: string;
  editable: boolean;
  content: any;
  pageId?: string;
  printMode?: boolean;
  /**
   * When rendering inside a public share, pass the share's id (or key). Lookups
   * for transclusion content then resolve against the share graph instead of
   * the viewer's personal permissions, so a share never leaks source content
   * that isn't itself shared.
   */
  shareId?: string;
}

export default function PageEditor({
  pageId,
  editable,
  content,
  canComment,
}: PageEditorProps) {
  const { t } = useTranslation();
  const { data: collabQuery, refetch: refetchCollabToken } = useCollabToken();
  const { pageSlug } = useParams();
  const slugId = extractPageSlugId(pageSlug);
  const [socket] = useState(getCollabSocket);
  const hasCollabToken = !!collabQuery?.token;

  useEffect(() => {
    if (!hasCollabToken) return;
    acquireCollabSocket();
    return () => releaseCollabSocket();
  }, [hasCollabToken]);

  const handleStateless = ({ payload }: onStatelessParameters) => {
    try {
      const message = JSON.parse(payload);
      if (message?.type !== "page.updated" || !message.updatedAt) return;
      const pageData = queryClient.getQueryData<IPage>(["pages", slugId]);
      if (pageData) {
        queryClient.setQueryData(["pages", slugId], {
          ...pageData,
          updatedAt: message.updatedAt,
          ...(message.lastUpdatedBy && {
            lastUpdatedBy: message.lastUpdatedBy,
          }),
        });
      }
    } catch {
      // ignore unrelated stateless messages
    }
  };

  const handleAuthenticationFailed = () => {
    const payload = jwtDecode(collabQuery?.token);
    const now = Date.now().valueOf() / 1000;
    const isTokenExpired = now >= payload.exp;
    if (isTokenExpired) {
      refetchCollabToken();
    }
  };

  return (
    <TransclusionLookupProvider>
      {collabQuery?.token ? (
        <HocuspocusProviderWebsocketComponent websocketProvider={socket}>
          <HocuspocusRoom
            name={`page.${pageId}`}
            token={collabQuery.token}
            flushDelay={500}
            onStateless={handleStateless}
            onAuthenticationFailed={handleAuthenticationFailed}
          >
            <CollabPageEditor
              pageId={pageId}
              editable={editable}
              content={content}
              canComment={canComment}
            />
          </HocuspocusRoom>
        </HocuspocusProviderWebsocketComponent>
      ) : (
        <StaticPageEditor content={content} ariaLabel={t("Page content")} />
      )}
    </TransclusionLookupProvider>
  );
}

function CollabPageEditor({
  pageId,
  printMode = false,
  shareId,
}: PageEditorProps) {
  const [, setReadOnlyEditor] = useAtom(readOnlyEditorAtom);
  const [lightboxRequest, setLightboxRequest] = useAtom(lightboxRequestAtom);
  const [contentEditor, setContentEditor] = useState<Editor | null>(null);
  const isComponentMounted = useRef(false);
  const editorRef = useRef<Editor | null>(null);

  useEffect(() => {
    isComponentMounted.current = true;
  }, []);

  const [currentUser] = useAtom(currentUserAtom);
  const [, setEditor] = useAtom(pageEditorAtom);
  const [, setAsideState] = useAtom(asideStateAtom);
  const [, setActiveCommentId] = useAtom(activeCommentIdAtom);
  const [showCommentPopup, setShowCommentPopup] = useAtom(showCommentPopupAtom);
  const [showReadOnlyCommentPopup] = useAtom(showReadOnlyCommentPopupAtom);
  const [lightboxRequest, setLightboxRequest] = useAtom(lightboxRequestAtom);
  const [isLocalSynced, setIsLocalSynced] = useState(false);
  const [isRemoteSynced, setIsRemoteSynced] = useState(false);
  const [yjsConnectionStatus, setYjsConnectionStatus] = useAtom(
    yjsConnectionStatusAtom,
  );
  const [, setYjsSynced] = useAtom(yjsSyncedAtom);
  const menuContainerRef = useRef(null);
  const { isIdle, resetIdle } = useIdle(FIVE_MINUTES, { initialState: false });
  const documentState = useDocumentVisibility();
  const { pageSlug } = useParams();
  const slugId = extractPageSlugId(pageSlug);
  const currentPageEditMode = useAtomValue(currentPageEditModeAtom);
  const canScroll = useCallback(
    () => Boolean(isComponentMounted.current && editorRef.current),
    [isComponentMounted],
  );
  const { handleScrollTo } = useEditorScroll({ canScroll });

  useEffect(() => {
    const local = new IndexeddbPersistence(
      provider.configuration.name,
      provider.document,
    );
    local.on("synced", () => setIsLocalSynced(true));
    return () => {
      local.destroy();
    };
  }, [provider]);

  useHocuspocusEvent("synced", ({ state }) => setIsRemoteSynced(state));
  useHocuspocusEvent("status", ({ status }) => setYjsConnectionStatus(status));

  // Only connect/disconnect on tab/idle, not destroy
  useEffect(() => {
    const socket = provider.configuration.websocketProvider;

    if (
      isIdle &&
      documentState === "hidden" &&
      yjsConnectionStatus === WebSocketStatus.Connected
    ) {
      socket.disconnect();
      return;
    }
    if (
      documentState === "visible" &&
      yjsConnectionStatus === WebSocketStatus.Disconnected
    ) {
      resetIdle();
      socket.connect();
    }
  }, [isIdle, documentState, provider, resetIdle]);

  useEffect(() => {
    if (!shareId) return;
    setLightboxRequest(null);
  }, [pageId, shareId]);

  const extensions = useMemo(() => {
    const excludedExtensions = new Set([
      "uniqueID",
      ...(printMode ? ["tableHeaderPin", "tableReadonlySort"] : []),
    ]);
    const filteredExtensions = mainExtensions.filter(
      (ext) => !excludedExtensions.has(ext.name),
    );

    return [
      ...filteredExtensions,
      UniqueID.configure({
        types: ["heading", "paragraph"],
        updateDocument: false,
      }),
    ];
  }, [printMode]);

  useEffect(() => {
    setActiveCommentId(null);
    setShowCommentPopup(false);
    setAsideState({ tab: "", isAsideOpen: false });
    setLightboxRequest(null);
  }, [pageId]);

  const isSynced = isLocalSynced && isRemoteSynced;

  useEffect(() => {
    setYjsSynced(isSynced);
  }, [isSynced, setYjsSynced]);

  useEffect(() => {
    return () => setYjsSynced(false);
  }, [setYjsSynced]);

  useEffect(() => {
    const timeout = setTimeout(() => {
      if (yjsConnectionStatus === WebSocketStatus.Connecting || !isSynced) {
        setYjsConnectionStatus(WebSocketStatus.Disconnected);
      }
    }, 7500);

    return () => clearTimeout(timeout);
  }, [yjsConnectionStatus, isSynced]);
  useEffect(() => {
    if (!editor) return;
    editor.setEditable(editable && currentPageEditMode === PageEditMode.Edit);
  }, [currentPageEditMode, editor, editable]);

  const hasConnectedOnceRef = useRef(false);
  const [showStatic, setShowStatic] = useState(true);

  useEffect(() => {
    if (
      !hasConnectedOnceRef.current &&
      yjsConnectionStatus === WebSocketStatus.Connected &&
      isSynced
    ) {
      hasConnectedOnceRef.current = true;
      setShowStatic(false);
    }
  }, [yjsConnectionStatus, isSynced]);

  if (showStatic) {
    return <StaticPageEditor content={content} ariaLabel={t("Page content")} />;
  }

  return (
    <TransclusionLookupProvider shareId={shareId}>
      <div className="page-title">
        <EditorProvider
          editable={false}
          immediatelyRender={true}
          textDirection="auto"
          extensions={titleExtensions}
          content={title}
        ></EditorProvider>
      </div>

      <EditorProvider
        editable={false}
        immediatelyRender={true}
        textDirection="auto"
        extensions={extensions}
        content={content}
        editorProps={
          shareId
            ? {
                handleClickOn: (_view, _pos, node) => {
                  const request = getLightboxClickRequest(node);
                  if (!request) return false;

                  setLightboxRequest(request);
                  return true;
                },
              }
            : undefined
        }
        onCreate={({ editor }) => {
          if (editor) {
            if (pageId) {
              // @ts-ignore
              editor.storage.pageId = pageId;
            }
            // @ts-ignore
            setReadOnlyEditor(editor);
            setContentEditor(editor);

        {editor && editorIsEditable && (
          <div>
            <EditorAiMenu editor={editor} />
            <EditorLinkMenu editor={editor} />
            <EditorBubbleMenu editor={editor} />
            <TableMenu editor={editor} />
            <TableHandlesLayer editor={editor} />
            <ImageMenu editor={editor} />
            <VideoMenu editor={editor} />
            <PdfMenu editor={editor} />
            <CalloutMenu editor={editor} />
            <SubpagesMenu editor={editor} />
            <ExcalidrawMenu editor={editor} />
            <DrawioMenu editor={editor} />
            <ColumnsMenu editor={editor} />
            <NextcloudPicker editor={editor} />
          </div>
        )}
        {editor && !editorIsEditable && (editable || canComment) && (
          <ReadonlyBubbleMenu editor={editor} />
        )}
        {editor && (
          <LightboxView
            editor={editor}
            open={!!lightboxRequest}
            src={lightboxRequest?.src ?? ""}
            type={lightboxRequest?.type ?? "image"}
            onClose={() => setLightboxRequest(null)}
          />
        )}
        {showCommentPopup && <CommentDialog editor={editor} pageId={pageId} />}
        {showReadOnlyCommentPopup && (
          <CommentDialog editor={editor} pageId={pageId} readOnly />
        )}
      </div>
      <div
        onClick={() => {
          if (editor && !editor.isDestroyed) editor.commands.focus("end");
        }}
      ></EditorProvider>
      {shareId && contentEditor && (
        <LightboxView
          editor={contentEditor}
          open={!!lightboxRequest}
          src={lightboxRequest?.src ?? ""}
          type={lightboxRequest?.type ?? "image"}
          onClose={() => setLightboxRequest(null)}
        />
      )}
      <div style={{ paddingBottom: "20vh" }}></div>
    </TransclusionLookupProvider>
  );
}
