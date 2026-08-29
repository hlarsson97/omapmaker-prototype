function pointerEvent(event) {
  return event?.touches?.[0] || event?.changedTouches?.[0] || event;
}

export function anchoredMapCenter(map, anchorLatLng, pivot, bearingRadians) {
  const viewHalf = map.getSize().divideBy(2);
  const screenOffset = pivot.subtract(viewHalf);
  const anchorPixel = map.project(anchorLatLng, map.getZoom());
  return map.unproject(anchorPixel.subtract(screenOffset.rotate(-bearingRadians)), map.getZoom());
}

export function anchoredRotationTranslation(pivot, viewHalf, deltaRadians) {
  const offset = pivot.subtract(viewHalf);
  return offset.subtract(offset.rotate(deltaRadians));
}

export function createSmoothMapMarkerFactory(Leaflet) {
  const BaseMarker = Leaflet.Marker;
  const SmoothMapMarker = BaseMarker.extend({
    getEvents() {
      const events = BaseMarker.prototype.getEvents.call(this);
      delete events.rotate;
      delete events.rotateend;
      return events;
    },

    _setPos(position) {
      let layerPosition = position;
      const map = this._map;
      if (map?._rotate && map._bearing && map.mapPanePointToRotatedPoint) {
        // leaflet-rotate normally converts markers into screen coordinates on
        // every frame. These markers already live inside the rotating pane, so
        // cancel that conversion and let the pane's single CSS transform move
        // the complete map atomically.
        layerPosition = map.mapPanePointToRotatedPoint(layerPosition);
      }
      return BaseMarker.prototype._setPos.call(this, layerPosition);
    },

    _captureDragPointer(event) {
      if (!this._map) return;
      const pointer = pointerEvent(event);
      const markerPoint = this._map.latLngToContainerPoint(this.getLatLng());
      this._omapDragPointerOffset = markerPoint.subtract(this._map.mouseEventToContainerPoint(pointer));
    },

    _initInteraction() {
      const result = BaseMarker.prototype._initInteraction.call(this);
      if (this._icon) {
        Leaflet.DomEvent.on(this._icon, 'mousedown touchstart', this._captureDragPointer, this);
      }
      const handler = this.dragging;
      if (!handler || handler._omapSmoothMapMarker) return result;
      const wasEnabled = handler.enabled();
      if (wasEnabled) handler.disable();
      const baseDragStart = handler._onDragStart;
      const baseDragEnd = handler._onDragEnd;
      handler._omapSmoothMapMarker = true;
      handler._onDragStart = function (event) {
        this._omapPointerOffset = this._marker._omapDragPointerOffset || Leaflet.point(0, 0);
        return baseDragStart.call(this, event);
      };
      handler._onDrag = function (event) {
        const marker = this._marker;
        const map = marker._map;
        const sourceEvent = pointerEvent(event?.originalEvent);
        if (!map || !sourceEvent) return;
        const pointer = map.mouseEventToContainerPoint(sourceEvent);
        const latlng = map.containerPointToLatLng(pointer.add(this._omapPointerOffset || Leaflet.point(0, 0)));
        marker._latlng = latlng;
        marker.update();
        event.latlng = latlng;
        event.oldLatLng = this._oldLatLng;
        marker.fire('move', event).fire('drag', event);
      };
      handler._onDragEnd = function (event) {
        const marker = this._marker;
        this._omapPointerOffset = null;
        marker._omapDragPointerOffset = null;
        return baseDragEnd.call(this, event);
      };
      if (wasEnabled) handler.enable();
      return result;
    }
  });

  return (latlng, options = {}) => new SmoothMapMarker(latlng, {...options, rotateWithView: false});
}

export function installMiddleButtonRotation({Leaflet, map, sensitivity = 0.45}) {
  const container = map.getContainer();
  const originalUpdateTransform = map._updateRotatePaneTransform;
  let enabled = false;
  let session = null;
  let animationFrame = null;
  let pendingBearing = null;

  map._updateRotatePaneTransform = function () {
    const gesture = this._omapMiddleRotation;
    if (!gesture || !this._rotatePane) {
      return originalUpdateTransform.call(this);
    }
    const viewHalf = this.getSize().divideBy(2);
    const translation = anchoredRotationTranslation(gesture.pivot, viewHalf, gesture.deltaRadians);
    this._rotatePane.style[Leaflet.DomUtil.TRANSFORM + 'Origin'] = `${viewHalf.x}px ${viewHalf.y}px`;
    this._rotatePane.style[Leaflet.DomUtil.TRANSFORM] = `translate3d(${translation.x}px,${translation.y}px,0) rotate(${this._bearingRad}rad)`;
  };

  function applyPendingBearing() {
    animationFrame = null;
    if (pendingBearing == null || !session) return;
    const previousBearing = map.getBearing();
    map.setBearing(pendingBearing);
    if (map.getBearing() === previousBearing) map._updateRotatePaneTransform();
  }

  function finish(event) {
    if (!session) return;
    if (animationFrame != null) {
      cancelAnimationFrame(animationFrame);
      animationFrame = null;
      applyPendingBearing();
    }
    const completed = session.moved;
    const anchor = session.anchor;
    const pivot = session.pivot;
    session = null;
    pendingBearing = null;
    delete map._omapMiddleRotation;
    if (completed) {
      const center = anchoredMapCenter(map, anchor, pivot, map._bearingRad || 0);
      map._rotating = false;
      map._resetView(center, map.getZoom(), true);
      map._updateRotatePaneTransform();
      map.fire('rotateend');
    }
    if (map.dragging && map.dragging._omapWasEnabledForRotation) {
      map.dragging._omapWasEnabledForRotation = false;
      map.dragging.enable();
    }
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('mouseup', finish, true);
    window.removeEventListener('blur', finish, true);
    if (event) event.preventDefault();
  }

  function onMove(event) {
    if (!session) return;
    if (typeof event.buttons === 'number' && (event.buttons & 4) === 0) return finish(event);
    const delta = (event.clientX - session.startX) * sensitivity;
    if (!session.moved && Math.abs(delta) < 1) return;
    if (!session.moved) {
      session.moved = true;
      map._rotating = true;
      map.closePopup();
      map.fire('rotatestart');
    }
    session.deltaRadians = delta * Math.PI / 180;
    map._omapMiddleRotation.deltaRadians = session.deltaRadians;
    pendingBearing = session.startBearing + delta;
    if (animationFrame == null) animationFrame = requestAnimationFrame(applyPendingBearing);
    event.preventDefault();
  }

  function onDown(event) {
    if (!enabled || event.button !== 1 || session) return;
    const pivot = map.mouseEventToContainerPoint(event);
    session = {
      startX: event.clientX,
      startBearing: map.getBearing(),
      pivot,
      anchor: map.containerPointToLatLng(pivot),
      deltaRadians: 0,
      moved: false
    };
    map._omapMiddleRotation = session;
    if (map.dragging?.enabled()) {
      map.dragging._omapWasEnabledForRotation = true;
      map.dragging.disable();
    }
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseup', finish, true);
    window.addEventListener('blur', finish, true);
    event.preventDefault();
    event.stopPropagation();
  }

  function preventAuxiliaryClick(event) {
    if (enabled && event.button === 1) event.preventDefault();
  }

  container.addEventListener('mousedown', onDown, true);
  container.addEventListener('auxclick', preventAuxiliaryClick, true);

  return {
    setEnabled(nextEnabled) {
      enabled = Boolean(nextEnabled);
      if (!enabled) finish();
    }
  };
}
