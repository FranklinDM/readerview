/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

var Ci = Components.interfaces, Cc = Components.classes, Cu = Components.utils;

this.EXPORTED_SYMBOLS = [ "AboutReader" ];

Cu.import("resource://readerview/ReaderMode.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");

XPCOMUtils.defineLazyModuleGetter(this, "NarrateControls", "resource://gre/modules/narrate/NarrateControls.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "Rect", "resource://gre/modules/Geometry.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "Task", "resource://gre/modules/Task.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "PluralForm", "resource://gre/modules/PluralForm.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "ReaderParent", "resource://readerview/ReaderParent.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "PlacesUtils", "resource://gre/modules/PlacesUtils.jsm");

var gStrings = Services.strings.createBundle("chrome://readerview/locale/aboutReader.properties");

var AboutReader = function(win, articlePromise) {
  let url = this._getOriginalUrl(win);
  if (!(url.startsWith("http://") || url.startsWith("https://"))) {
    let errorMsg = "Only http:// and https:// URLs can be loaded in about:reader.";
    if (Services.prefs.getBoolPref("extensions.reader.errors.includeURLs"))
      errorMsg += " Tried to load: " + url + ".";
    Cu.reportError(errorMsg);
    win.location.href = "about:blank";
    return;
  }

  let doc = win.document;

  this._docRef = Cu.getWeakReference(doc);
  this._winRef = Cu.getWeakReference(win);
  this._innerWindowId = win.QueryInterface(Ci.nsIInterfaceRequestor)
    .getInterface(Ci.nsIDOMWindowUtils).currentInnerWindowID;

  this._article = null;

  if (articlePromise) {
    this._articlePromise = articlePromise;
  }

  this._headerElementRef = Cu.getWeakReference(doc.querySelector(".reader-header"));
  this._domainElementRef = Cu.getWeakReference(doc.querySelector(".reader-domain"));
  this._titleElementRef = Cu.getWeakReference(doc.querySelector(".reader-title"));
  this._readTimeElementRef = Cu.getWeakReference(doc.querySelector(".reader-estimated-time"));
  this._creditsElementRef = Cu.getWeakReference(doc.querySelector(".reader-credits"));
  this._contentElementRef = Cu.getWeakReference(doc.querySelector(".moz-reader-content"));
  this._toolbarElementRef = Cu.getWeakReference(doc.querySelector(".reader-toolbar"));
  this._messageElementRef = Cu.getWeakReference(doc.querySelector(".reader-message"));
  this._containerElementRef = Cu.getWeakReference(doc.querySelector(".container"));

  this._scrollOffset = win.pageYOffset;

  doc.addEventListener("click", this);

  win.addEventListener("pagehide", this);
  win.addEventListener("scroll", this);
  win.addEventListener("resize", this);

  Services.obs.addObserver(this, "inner-window-destroyed", false);

  doc.addEventListener("visibilitychange", this);

  this._setupStyleDropdown();
  this._setupButton("close-button", this._onReaderClose.bind(this), "aboutReader.toolbar.close");

    // we're ready for any external setup, send a signal for that.
//TODO: Implement this
//  document.dispatchEvent(new CustomEvent("ReaderOnSetup"));


  let colorSchemeValues = JSON.parse(Services.prefs.getCharPref("extensions.reader.color_scheme.values"));
  let colorSchemeOptions = colorSchemeValues.map((value) => {
    return {
      name: gStrings.GetStringFromName("aboutReader.colorScheme." + value),
      value,
      itemClass: value + "-button"
    };
  });

  let colorScheme = Services.prefs.getCharPref("extensions.reader.color_scheme");
  this._setupSegmentedButton("color-scheme-buttons", colorSchemeOptions, colorScheme, this._setColorSchemePref.bind(this));
  this._setColorSchemePref(colorScheme);

  let fontTypeSample = gStrings.GetStringFromName("aboutReader.fontTypeSample");
  let fontTypeOptions = [
    { name: fontTypeSample,
      description: gStrings.GetStringFromName("aboutReader.fontType.sans-serif"),
      value: "sans-serif",
      itemClass: "sans-serif-button"
    },
    { name: fontTypeSample,
      description: gStrings.GetStringFromName("aboutReader.fontType.serif"),
      value: "serif",
      itemClass: "serif-button" },
  ];

  let fontType = Services.prefs.getCharPref("extensions.reader.font_type");
  this._setupSegmentedButton("font-type-buttons", fontTypeOptions, fontType, this._setFontType.bind(this));
  this._setFontType(fontType);

  this._setupFontSizeButtons();

  this._setupContentWidthButtons();

  this._setupLineHeightButtons();

  this._loadArticle();
};

AboutReader.prototype = {
  _BLOCK_IMAGES_SELECTOR: ".content p > img:only-child, " +
                          ".content p > a:only-child > img:only-child, " +
                          ".content .wp-caption img, " +
                          ".content figure img",

  get _doc() {
    return this._docRef.get();
  },

  get _win() {
    return this._winRef.get();
  },

  get _headerElement() {
    return this._headerElementRef.get();
  },

  get _domainElement() {
    return this._domainElementRef.get();
  },

  get _titleElement() {
    return this._titleElementRef.get();
  },

  get _readTimeElement() {
    return this._readTimeElementRef.get();
  },

  get _creditsElement() {
    return this._creditsElementRef.get();
  },

  get _contentElement() {
    return this._contentElementRef.get();
  },

  get _toolbarElement() {
    return this._toolbarElementRef.get();
  },

  get _messageElement() {
    return this._messageElementRef.get();
  },

  get _containerElement() {
    return this._containerElementRef.get();
  },

  get _isToolbarVertical() {
    if (this._toolbarVertical !== undefined) {
      return this._toolbarVertical;
    }
    return this._toolbarVertical = Services.prefs.getBoolPref("extensions.reader.toolbar.vertical");
  },

  // Provides unique view Id.
  get viewId() {
    let _viewId = Cc["@mozilla.org/uuid-generator;1"].
      getService(Ci.nsIUUIDGenerator).generateUUID().toString();
    Object.defineProperty(this, "viewId", { value: _viewId });

    return _viewId;
  },

  addButton(id, title, text, image) {
    if (id && image && !this._doc.getElementById(id)) {
      let btn = this._doc.createElement("button");
      btn.setAttribute("class", "button");
      btn.setAttribute("style", "background-image: url('" + image + "')");
      btn.setAttribute("id", id);
      if (title)
        btn.setAttribute("title", title);
      if (text)
        btn.textContent = text;
      let tb = this._doc.getElementById("reader-toolbar");
      tb.appendChild(btn);
      this._setupButton(id, button => {
//TODO: implement this
//        document.dispatchEvent(new CustomEvent("ReaderClicked-" + button.getAttribute("id"), {article: this._article }));
      });
    };
  },

  removeButton(id) {
    if (message.data.id) {
      let btn = this._doc.getElementById(id);
      if (btn)
        btn.remove();
    }
  },

  handleEvent(aEvent) {
    if (!aEvent.isTrusted)
      return;

    switch (aEvent.type) {
      case "click":
        let target = aEvent.target;
        if (target.classList.contains("dropdown-toggle")) {
          this._toggleDropdownClicked(aEvent);
        } else if (!target.closest(".dropdown-popup")) {
          this._closeDropdowns();
        }
        break;
      case "scroll":
        this._closeDropdowns(true);
        this._scrollOffset = aEvent.pageY;
        break;
      case "resize":
        this._updateImageMargins();
        if (this._isToolbarVertical) {
          this._win.setTimeout(() => {
            for (let dropdown of this._doc.querySelectorAll(".dropdown.open")) {
              this._updatePopupPosition(dropdown);
            }
          }, 0);
        }
        break;

      case "devicelight":
        this._handleDeviceLight(aEvent.value);
        break;

      case "visibilitychange":
        this._handleVisibilityChange();
        break;

      case "pagehide":
        // Close the Banners Font-dropdown, cleanup Android BackPressListener.
        this._closeDropdowns();

        this._windowUnloaded = true;
        break;
    }
  },

  observe(subject, topic, data) {
    if (subject.QueryInterface(Ci.nsISupportsPRUint64).data != this._innerWindowId) {
      return;
    }

    Services.obs.removeObserver(this, "inner-window-destroyed");

    this._windowUnloaded = true;
  },

  _onReaderClose() {
    ReaderMode.leaveReaderMode(this._win.content.document.docShell, this._win);
  },

  _setFontSize(newFontSize) {
    let containerClasses = this._containerElement.classList;

    if (this._fontSize > 0)
      containerClasses.remove("font-size" + this._fontSize);

    this._fontSize = newFontSize;
    containerClasses.add("font-size" + this._fontSize);
    Services.prefs.setIntPref("extensions.reader.font_size", this._fontSize);
  },

  _setupFontSizeButtons() {
    const FONT_SIZE_MIN = 1;
    const FONT_SIZE_MAX = 9;

    // Sample text shown in Android UI.
    let sampleText = this._doc.querySelector(".font-size-sample");
    sampleText.textContent = gStrings.GetStringFromName("aboutReader.fontTypeSample");

    let currentSize = Services.prefs.getIntPref("extensions.reader.font_size");
    currentSize = Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, currentSize));

    let plusButton = this._doc.querySelector(".plus-button");
    let minusButton = this._doc.querySelector(".minus-button");

    function updateControls() {
      if (currentSize === FONT_SIZE_MIN) {
        minusButton.setAttribute("disabled", true);
      } else {
        minusButton.removeAttribute("disabled");
      }
      if (currentSize === FONT_SIZE_MAX) {
        plusButton.setAttribute("disabled", true);
      } else {
        plusButton.removeAttribute("disabled");
      }
    }

    updateControls();
    this._setFontSize(currentSize);

    plusButton.addEventListener("click", (event) => {
      if (!event.isTrusted) {
        return;
      }
      event.stopPropagation();

      if (currentSize >= FONT_SIZE_MAX) {
        return;
      }

      currentSize++;
      updateControls();
      this._setFontSize(currentSize);
    }, true);

    minusButton.addEventListener("click", (event) => {
      if (!event.isTrusted) {
        return;
      }
      event.stopPropagation();

      if (currentSize <= FONT_SIZE_MIN) {
        return;
      }

      currentSize--;
      updateControls();
      this._setFontSize(currentSize);
    }, true);
  },

  _setContentWidth(newContentWidth) {
    let containerClasses = this._containerElement.classList;

    if (this._contentWidth > 0)
      containerClasses.remove("content-width" + this._contentWidth);

    this._contentWidth = newContentWidth;
    containerClasses.add("content-width" + this._contentWidth);
    Services.prefs.setIntPref("extensions.reader.content_width", this._contentWidth);
  },

  _setupContentWidthButtons() {
    const CONTENT_WIDTH_MIN = 1;
    const CONTENT_WIDTH_MAX = 9;

    let currentContentWidth = Services.prefs.getIntPref("extensions.reader.content_width");
    currentContentWidth = Math.max(CONTENT_WIDTH_MIN, Math.min(CONTENT_WIDTH_MAX, currentContentWidth));

    let plusButton = this._doc.querySelector(".content-width-plus-button");
    let minusButton = this._doc.querySelector(".content-width-minus-button");

    function updateControls() {
      if (currentContentWidth === CONTENT_WIDTH_MIN) {
        minusButton.setAttribute("disabled", true);
      } else {
        minusButton.removeAttribute("disabled");
      }
      if (currentContentWidth === CONTENT_WIDTH_MAX) {
        plusButton.setAttribute("disabled", true);
      } else {
        plusButton.removeAttribute("disabled");
      }
    }

    updateControls();
    this._setContentWidth(currentContentWidth);

    plusButton.addEventListener("click", (event) => {
      if (!event.isTrusted) {
        return;
      }
      event.stopPropagation();

      if (currentContentWidth >= CONTENT_WIDTH_MAX) {
        return;
      }

      currentContentWidth++;
      updateControls();
      this._setContentWidth(currentContentWidth);
    }, true);

    minusButton.addEventListener("click", (event) => {
      if (!event.isTrusted) {
        return;
      }
      event.stopPropagation();

      if (currentContentWidth <= CONTENT_WIDTH_MIN) {
        return;
      }

      currentContentWidth--;
      updateControls();
      this._setContentWidth(currentContentWidth);
    }, true);
  },

  _setLineHeight(newLineHeight) {
    let contentClasses = this._contentElement.classList;

    if (this._lineHeight > 0)
      contentClasses.remove("line-height" + this._lineHeight);

    this._lineHeight = newLineHeight;
    contentClasses.add("line-height" + this._lineHeight);
    Services.prefs.setIntPref("extensions.reader.line_height", this._lineHeight);
  },

  _setupLineHeightButtons() {
    const LINE_HEIGHT_MIN = 1;
    const LINE_HEIGHT_MAX = 9;

    let currentLineHeight = Services.prefs.getIntPref("extensions.reader.line_height");
    currentLineHeight = Math.max(LINE_HEIGHT_MIN, Math.min(LINE_HEIGHT_MAX, currentLineHeight));

    let plusButton = this._doc.querySelector(".line-height-plus-button");
    let minusButton = this._doc.querySelector(".line-height-minus-button");

    function updateControls() {
      if (currentLineHeight === LINE_HEIGHT_MIN) {
        minusButton.setAttribute("disabled", true);
      } else {
        minusButton.removeAttribute("disabled");
      }
      if (currentLineHeight === LINE_HEIGHT_MAX) {
        plusButton.setAttribute("disabled", true);
      } else {
        plusButton.removeAttribute("disabled");
      }
    }

    updateControls();
    this._setLineHeight(currentLineHeight);

    plusButton.addEventListener("click", (event) => {
      if (!event.isTrusted) {
        return;
      }
      event.stopPropagation();

      if (currentLineHeight >= LINE_HEIGHT_MAX) {
        return;
      }

      currentLineHeight++;
      updateControls();
      this._setLineHeight(currentLineHeight);
    }, true);

    minusButton.addEventListener("click", (event) => {
      if (!event.isTrusted) {
        return;
      }
      event.stopPropagation();

      if (currentLineHeight <= LINE_HEIGHT_MIN) {
        return;
      }

      currentLineHeight--;
      updateControls();
      this._setLineHeight(currentLineHeight);
    }, true);
  },

  _handleDeviceLight(newLux) {
    // Desired size of the this._luxValues array.
    let luxValuesSize = 10;
    // Add new lux value at the front of the array.
    this._luxValues.unshift(newLux);
    // Add new lux value to this._totalLux for averaging later.
    this._totalLux += newLux;

    // Don't update when length of array is less than luxValuesSize except when it is 1.
    if (this._luxValues.length < luxValuesSize) {
      // Use the first lux value to set the color scheme until our array equals luxValuesSize.
      if (this._luxValues.length == 1) {
        this._updateColorScheme(newLux);
      }
      return;
    }
    // Holds the average of the lux values collected in this._luxValues.
    let averageLuxValue = this._totalLux / luxValuesSize;

    this._updateColorScheme(averageLuxValue);
    // Pop the oldest value off the array.
    let oldLux = this._luxValues.pop();
    // Subtract oldLux since it has been discarded from the array.
    this._totalLux -= oldLux;
  },

  _handleVisibilityChange() {
    let colorScheme = Services.prefs.getCharPref("extensions.reader.color_scheme");
    if (colorScheme != "auto") {
      return;
    }

    // Turn off the ambient light sensor if the page is hidden
    this._enableAmbientLighting(!this._doc.hidden);
  },

  // Setup or teardown the ambient light tracking system.
  _enableAmbientLighting(enable) {
    if (enable) {
      this._win.addEventListener("devicelight", this);
      this._luxValues = [];
      this._totalLux = 0;
    } else {
      this._win.removeEventListener("devicelight", this);
      delete this._luxValues;
      delete this._totalLux;
    }
  },

  _updateColorScheme(luxValue) {
    // Upper bound value for "dark" color scheme beyond which it changes to "light".
    let upperBoundDark = 50;
    // Lower bound value for "light" color scheme beyond which it changes to "dark".
    let lowerBoundLight = 10;
    // Threshold for color scheme change.
    let colorChangeThreshold = 20;

    // Ignore changes that are within a certain threshold of previous lux values.
    if ((this._colorScheme === "dark" && luxValue < upperBoundDark) ||
        (this._colorScheme === "light" && luxValue > lowerBoundLight))
      return;

    if (luxValue < colorChangeThreshold)
      this._setColorScheme("dark");
    else
      this._setColorScheme("light");
  },

  _setColorScheme(newColorScheme) {
    // "auto" is not a real color scheme
    if (this._colorScheme === newColorScheme || newColorScheme === "auto")
      return;

    let bodyClasses = this._doc.body.classList;

    if (this._colorScheme)
      bodyClasses.remove(this._colorScheme);

    this._colorScheme = newColorScheme;
    bodyClasses.add(this._colorScheme);
  },

  // Pref values include "dark", "light", and "auto", which automatically switches
  // between light and dark color schemes based on the ambient light level.
  _setColorSchemePref(colorSchemePref) {
    this._enableAmbientLighting(colorSchemePref === "auto");
    this._setColorScheme(colorSchemePref);

    Services.prefs.setCharPref("extensions.reader.color_scheme", colorSchemePref);
  },

  _setFontType(newFontType) {
    if (this._fontType === newFontType)
      return;

    let bodyClasses = this._doc.body.classList;

    if (this._fontType)
      bodyClasses.remove(this._fontType);

    this._fontType = newFontType;
    bodyClasses.add(this._fontType);

    Services.prefs.setCharPref("extensions.reader.font_type", this._fontType);
  },

  _setSystemUIVisibility(visible) {
//TODO: Implement this
//    document.dispatchEvent(new CustomEvent("ReaderSystemUIVisibility"));
  },

  _setToolbarVisibility(visible) {
    let tb = this._toolbarElement;

    if (visible) {
      if (tb.style.opacity != "1") {
        tb.removeAttribute("hidden");
        tb.style.opacity = "1";
      }
    } else if (tb.style.opacity != "0") {
      tb.addEventListener("transitionend", evt => {
        if (tb.style.opacity == "0") {
          tb.setAttribute("hidden", "");
        }
      }, { once: true });
      tb.style.opacity = "0";
    }
  },

  _loadArticle: Task.async(function* () {
    let url = this._getOriginalUrl();
    this._showProgressDelayed();

    let article;
    if (this._articlePromise) {
      article = yield this._articlePromise;
    } else {
      try {
        article = yield this._getArticle(url);
      } catch (e) {
        if (e && e.newURL) {
          let readerURL = "about:reader?url=" + encodeURIComponent(e.newURL);
          this._win.location.replace(readerURL);
          return;
        }
      }
    }

    if (this._windowUnloaded) {
      return;
    }

    // Replace the loading message with an error message if there's a failure.
    // Users are supposed to navigate away by themselves (because we cannot
    // remove ourselves from session history.)
    if (!article) {
      this._showError();
      return;
    }

    this._showContent(article);
  }),

  _getArticle(url) {
    return new Promise((resolve, reject) => {
      try {
        resolve(ReaderMode.downloadAndParseDocument(url));
      } catch (e) {
        if(e && e.newURL) {
          reject({ newURL: e.newURL });
        }
        Cu.reportError("Error downloading and parsing document: " + e);
      }
    });
  },

  _requestFavicon() {
    let url = this._article.url;
    let faviconUrl = PlacesUtils.promiseFaviconLinkUrl(url);
    var self = this;
    faviconUrl.then(function onResolution(favicon) {
      self._loadFavicon(url, favicon.path.replace(/^favicon:/, ""));
    },
    function onRejection(reason) {
      Cu.reportError("Error requesting favicon URL for about:reader content: " + reason);
    }).catch(Cu.reportError);
  },

  _loadFavicon(url, faviconUrl) {
    if (this._article.url !== url)
      return;

    let doc = this._doc;

    let link = doc.createElement("link");
    link.rel = "shortcut icon";
    link.href = faviconUrl;

    doc.getElementsByTagName("head")[0].appendChild(link);
  },

  _updateImageMargins() {
    let windowWidth = this._win.innerWidth;
    let bodyWidth = this._doc.body.clientWidth;

    let setImageMargins = function(img) {
      // If the image is at least as wide as the window, make it fill edge-to-edge on mobile.
      if (img.naturalWidth >= windowWidth) {
        img.setAttribute("moz-reader-full-width", true);
      } else {
        img.removeAttribute("moz-reader-full-width");
      }

      // If the image is at least half as wide as the body, center it on desktop.
      if (img.naturalWidth >= bodyWidth / 2) {
        img.setAttribute("moz-reader-center", true);
      } else {
        img.removeAttribute("moz-reader-center");
      }
    };

    let imgs = this._doc.querySelectorAll(this._BLOCK_IMAGES_SELECTOR);
    for (let i = imgs.length; --i >= 0;) {
      let img = imgs[i];

      if (img.naturalWidth > 0) {
        setImageMargins(img);
      } else {
        img.onload = function() {
          setImageMargins(img);
        };
      }
    }
  },

  _formatReadTime(slowEstimate, fastEstimate) {
    let displayStringKey = "aboutReader.estimatedReadTimeRange1";

    // only show one reading estimate when they are the same value
    if (slowEstimate == fastEstimate) {
      displayStringKey = "aboutReader.estimatedReadTimeValue1";
    }

    return PluralForm.get(slowEstimate, gStrings.GetStringFromName(displayStringKey))
      .replace("#1", fastEstimate)
      .replace("#2", slowEstimate);
  },

  _showError() {
    this._headerElement.style.display = "none";
    this._contentElement.style.display = "none";

    let errorMessage = gStrings.GetStringFromName("aboutReader.loadError");
    this._messageElement.textContent = errorMessage;
    this._messageElement.style.display = "block";

    this._doc.title = errorMessage;

    this._doc.documentElement.dataset.isError = true;

    this._error = true;

    this._doc.dispatchEvent(
      new this._win.CustomEvent("AboutReaderContentError", { bubbles: true, cancelable: false }));
  },

  // This function is the JS version of Java's StringUtils.stripCommonSubdomains.
  _stripHost(host) {
    if (!host)
      return host;

    let start = 0;

    if (host.startsWith("www."))
      start = 4;
    else if (host.startsWith("m."))
      start = 2;
    else if (host.startsWith("mobile."))
      start = 7;

    return host.substring(start);
  },

  _showContent(article) {
    this._messageElement.style.display = "none";

    this._article = article;

    this._domainElement.href = article.url;
    let articleUri = Services.io.newURI(article.url, null, null);
    this._domainElement.textContent = this._stripHost(articleUri.host);
    this._creditsElement.textContent = article.byline;

    this._titleElement.textContent = article.title;
    this._readTimeElement.textContent = this._formatReadTime(article.readingTimeMinsSlow, article.readingTimeMinsFast);
    this._doc.title = article.title;

    this._headerElement.style.display = "block";

    let parserUtils = Cc["@mozilla.org/parserutils;1"].getService(Ci.nsIParserUtils);
    let contentFragment = parserUtils.parseFragment(article.content,
      Ci.nsIParserUtils.SanitizerDropForms | Ci.nsIParserUtils.SanitizerAllowStyle,
      false, articleUri, this._contentElement);
    this._contentElement.innerHTML = "";
    this._contentElement.appendChild(contentFragment);

    this._contentElement.style.display = "block";
    this._updateImageMargins();

    this._requestFavicon();
    this._doc.body.classList.add("loaded");

    this._goToReference(articleUri.ref);

    Services.obs.notifyObservers(this._win, "AboutReader:Ready", "");

    this._doc.dispatchEvent(
      new this._win.CustomEvent("AboutReaderContentReady", { bubbles: true, cancelable: false }));
  },

  _hideContent() {
    this._headerElement.style.display = "none";
    this._contentElement.style.display = "none";
  },

  _showProgressDelayed() {
    this._win.setTimeout(() => {
      // No need to show progress if the article has been loaded,
      // if the window has been unloaded, or if there was an error
      // trying to load the article.
      if (this._article || this._windowUnloaded || this._error) {
        return;
      }

      this._headerElement.style.display = "none";
      this._contentElement.style.display = "none";

      this._messageElement.textContent = gStrings.GetStringFromName("aboutReader.loading2");
      this._messageElement.style.display = "block";
    }, 300);
  },

  /**
   * Returns the original article URL for this about:reader view.
   */
  _getOriginalUrl(win) {
    let url = win ? win.location.href : this._win.location.href;
    return ReaderMode.getOriginalUrl(url) || url;
  },

  _setupSegmentedButton(id, options, initialValue, callback) {
    let doc = this._doc;
    let segmentedButton = doc.getElementsByClassName(id)[0];

    for (let i = 0; i < options.length; i++) {
      let option = options[i];

      let item = doc.createElement("button");

      // Put the name in a div so that Android can hide it.
      let div = doc.createElement("div");
      div.textContent = option.name;
      div.classList.add("name");
      item.appendChild(div);

      if (option.itemClass !== undefined)
        item.classList.add(option.itemClass);

      if (option.description !== undefined) {
        let description = doc.createElement("div");
        description.textContent = option.description;
        description.classList.add("description");
        item.appendChild(description);
      }

      segmentedButton.appendChild(item);

      item.addEventListener("click", function(aEvent) {
        if (!aEvent.isTrusted)
          return;

        aEvent.stopPropagation();

        let items = segmentedButton.children;
        for (let j = items.length - 1; j >= 0; j--) {
          items[j].classList.remove("selected");
        }

        item.classList.add("selected");
        callback(option.value);
      }, true);

      if (option.value === initialValue)
        item.classList.add("selected");
    }
  },

  _setupButton(id, callback, titleEntity, textEntity) {
    if (titleEntity) {
      this._setButtonTip(id, titleEntity);
    }

    let button = this._doc.getElementsByClassName(id)[0];
    if (textEntity) {
      button.textContent = gStrings.GetStringFromName(textEntity);
    }
    button.removeAttribute("hidden");
    button.addEventListener("click", function(aEvent) {
      if (!aEvent.isTrusted)
        return;

      aEvent.stopPropagation();
      let btn = aEvent.target;
      callback(btn);
    }, true);
  },

  /**
   * Sets a toolTip for a button. Performed at initial button setup
   * and dynamically as button state changes.
   * @param   Localizable string providing UI element usage tip.
   */
  _setButtonTip(id, titleEntity) {
    let button = this._doc.getElementsByClassName(id)[0];
    button.setAttribute("title", gStrings.GetStringFromName(titleEntity));
  },

  _setupStyleDropdown() {
    let dropdownToggle = this._doc.querySelector(".style-dropdown .dropdown-toggle");
    dropdownToggle.setAttribute("title", gStrings.GetStringFromName("aboutReader.toolbar.typeControls"));
  },

  _updatePopupPosition(dropdown) {
    let dropdownToggle = dropdown.querySelector(".dropdown-toggle");
    let dropdownPopup = dropdown.querySelector(".dropdown-popup");

    let toggleHeight = dropdownToggle.offsetHeight;
    let toggleTop = dropdownToggle.offsetTop;
    let popupTop = toggleTop - toggleHeight / 2;

    dropdownPopup.style.top = popupTop + "px";
  },

  _toggleDropdownClicked(event) {
    let dropdown = event.target.closest(".dropdown");

    if (!dropdown)
      return;

    event.stopPropagation();

    if (dropdown.classList.contains("open")) {
      this._closeDropdowns();
    } else {
      this._openDropdown(dropdown);
      if (this._isToolbarVertical) {
        this._updatePopupPosition(dropdown);
      }
    }
  },

  /*
   * If the ReaderView banner font-dropdown is closed, open it.
   */
  _openDropdown(dropdown) {
    if (dropdown.classList.contains("open")) {
      return;
    }

    this._closeDropdowns();

    // Trigger BackPressListener initialization in Android.
    dropdown.classList.add("open");
//TODO: Implement this
//    document.dispatchEvent(new CustomEvent("ReaderDropdownOpened"));
  },

  /*
   * If the ReaderView has open dropdowns, close them. If we are closing the
   * dropdowns because the page is scrolling, allow popups to stay open with
   * the keep-open class.
   */
  _closeDropdowns(scrolling) {
    let selector = ".dropdown.open";
    if (scrolling) {
      selector += ":not(.keep-open)";
    }

    let openDropdowns = this._doc.querySelectorAll(selector);
    for (let dropdown of openDropdowns) {
      dropdown.classList.remove("open");
    }

    // Trigger BackPressListener cleanup in Android.
    if (openDropdowns.length) {
//TODO: Implement this
//      document.dispatchEvent(new CustomEvent("ReaderDropdownClosed"));
    }
  },

  /*
   * Scroll reader view to a reference
   */
  _goToReference(ref) {
    if (ref) {
      this._win.location.hash = ref;
    }
  }
};
