/* @flow */

import React, { Component } from "react";

import Icon from "metabase/components/Icon";
import OnClickOutsideWrapper from "metabase/components/OnClickOutsideWrapper";

import MetabaseAnalytics from "metabase/lib/analytics";

import cx from "classnames";
import _ from "underscore";

import type { Card, UnsavedCard } from "metabase/meta/types/Card";
import type { ClickAction } from "metabase/meta/types/Visualization";
import Question from "metabase-lib/lib/Question";

type Props = {
    className?: string,
    card: Card,
    question: Question,
    setCardAndRun: (card: Card) => void,
    navigateToNewCardInsideQB: (any) => void
};

type State = {
    isVisible: boolean,
    isOpen: boolean,
    selectedActionIndex: ?number
};

const CIRCLE_SIZE = 48;
const NEEDLE_SIZE = 20;
const POPOVER_WIDTH = 350;

export default class ActionsWidget extends Component {
    props: Props;
    state: State = {
        isVisible: false,
        isOpen: false,
        selectedActionIndex: null
    };

    componentWillMount() {
        window.addEventListener("mousemove", this.handleMouseMoved, false);
    }

    componentWillUnmount() {
        window.removeEventListener("mousemove", this.handleMouseMoved, false);
    }

    handleMouseMoved = () => {
        if (!this.state.isVisible) {
            this.setState({ isVisible: true });
        }
        this.handleMouseStoppedMoving();
    };

    handleMouseStoppedMoving = _.debounce(
        () => {
            this.setState({ isVisible: false });
        },
        1000
    );

    close = () => {
        this.setState({ isOpen: false, selectedActionIndex: null });
    };

    toggle = () => {
        if (!this.state.isOpen) {
            MetabaseAnalytics.trackEvent("Actions", "Opened Action Menu");
        }
        this.setState({
            isOpen: !this.state.isOpen,
            selectedActionIndex: null
        });
    };

    handleOnChangeCardAndRun = ({ nextCard }: { nextCard: Card|UnsavedCard}) => {
        // TODO: move lineage logic to Question?
        const { card: previousCard } = this.props;
        this.props.navigateToNewCardInsideQB({ nextCard, previousCard });
    }

    handleActionClick = (index: number) => {
        const { question } = this.props;
        const action = question.actions()[index];
        if (action && action.popover) {
            this.setState({ selectedActionIndex: index });
        } else if (action && action.question) {
            const nextQuestion = action.question();
            if (nextQuestion) {
                MetabaseAnalytics.trackEvent("Actions", "Executed Action", `${action.section||""}:${action.name||""}`);
                this.handleOnChangeCardAndRun({ nextCard: nextQuestion.card() });
            }
            this.close();
        }
    };
    render() {
        const { className, question } = this.props;
        const { isOpen, isVisible, selectedActionIndex } = this.state;

        const actions = question.actions();
        if (actions.length === 0) {
            return null;
        }

        const selectedAction: ?ClickAction = selectedActionIndex == null ? null :
            actions[selectedActionIndex];
        let PopoverComponent = selectedAction && selectedAction.popover;

        return (
            <div className={cx(className, "relative")}>
                <div
                    className="circular bg-brand flex layout-centered m3 cursor-pointer"
                    style={{
                        width: CIRCLE_SIZE,
                        height: CIRCLE_SIZE,
                        transition: "opacity 300ms ease-in-out",
                        opacity: isOpen || isVisible ? 1 : 0,
                        boxShadow: "2px 2px 4px rgba(0, 0, 0, 0.2)"
                    }}
                    onClick={this.toggle}
                >
                    <Icon
                        name="compass_needle"
                        className="text-white"
                        style={{
                            transition: "transform 500ms ease-in-out",
                            transform: isOpen
                                ? "rotate(0deg)"
                                : "rotate(720deg)"
                        }}
                        size={NEEDLE_SIZE}
                    />
                </div>
                {isOpen &&
                    <OnClickOutsideWrapper handleDismissal={() => {
                        MetabaseAnalytics.trackEvent("Actions", "Dismissed Action Menu");
                        this.close();
                    }}>
                        <div
                            className="absolute bg-white rounded bordered shadowed py1"
                            style={{
                                width: POPOVER_WIDTH,
                                bottom: "50%",
                                right: "50%",
                                zIndex: -1
                            }}
                        >
                            {PopoverComponent
                                ? <div>
                                      <div
                                          className="flex align-center text-grey-4 p1 px2"
                                      >
                                          <Icon
                                              name="chevronleft"
                                              className="cursor-pointer"
                                              onClick={() => this.setState({
                                                  selectedActionIndex: null
                                              })}
                                          />
                                          <div
                                              className="text-centered flex-full"
                                          >
                                              {selectedAction && selectedAction.title}
                                          </div>
                                      </div>
                                      <PopoverComponent
                                          onChangeCardAndRun={({ nextCard }) => {
                                              if (nextCard) {
                                                  if (selectedAction) {
                                                      MetabaseAnalytics.trackEvent("Actions", "Executed Action", `${selectedAction.section||""}:${selectedAction.name||""}`);
                                                  }
                                                  this.handleOnChangeCardAndRun({ nextCard })
                                              }
                                          }}
                                          onClose={this.close}
                                      />
                                  </div>
                                : actions.map((action, index) => (
                                      <div
                                          key={index}
                                          className="p2 flex align-center text-grey-4 brand-hover cursor-pointer"
                                          onClick={() =>
                                              this.handleActionClick(index)}
                                      >
                                          {action.icon &&
                                              <Icon
                                                  name={action.icon}
                                                  className="mr1 flex-no-shrink"
                                                  size={16}
                                              />}
                                          <div>
                                              {action.title}
                                          </div>
                                      </div>
                                  ))}
                        </div>
                    </OnClickOutsideWrapper>}
            </div>
        );
    }
}
